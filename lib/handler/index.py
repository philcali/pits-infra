import json
import boto3
import botocore
import os
import string
import random
from time import time
from math import floor

def handler(event, context):
    print(f'Event payload: {json.dumps(event)}')
    letters = string.ascii_letters
    s3 = boto3.client('s3')
    sns = boto3.client('sns')
    ddb = boto3.resource('dynamodb')
    topic_arn = os.getenv('NOTIFICATION_TOPIC_ARN')
    table_name = os.getenv('TABLE_NAME')
    domain_name = os.getenv('DOMAIN_NAME')
    table = ddb.Table(table_name)
    for record in event['Records']:
        presigned_url = s3.generate_presigned_url(
            'get_object',
            Params={
                'Bucket': record['s3']['bucket']['name'],
                'Key': record['s3']['object']['key']
            },
            ExpiresIn=3600)
        thing_name = record['s3']['object']['key'].split('/')[-2]
        attempt = 0
        while attempt < 3:
            attempt += 1
            random_string = ''.join(random.choice(letters) for i in range(10))
            try:
                table.put_item(
                    Item={
                        'PK': thing_name,
                        'SK': random_string,
                        'bucket': record['s3']['bucket']['name'],
                        'key': record['s3']['object']['key'],
                        'url': presigned_url,
                        'expiresIn': floor(time()) + 3600
                    },
                    ConditionExpression='attribute_not_exists(PK) AND attribute_not_exists(SK)')
                message = f'There was motion detected on {thing_name}: https://{domain_name}/{thing_name}/{random_string}'
                sns.publish(TopicArn=topic_arn, Message=message, Subject="Motion Video Alert")
                print(f'Sent notification to {topic_arn} about s3://{record["s3"]["bucket"]["name"]}/{record["s3"]["object"]["key"]}')
                break
            except botocore.exceptions.ClientError as e:
                if e.response['Error']['Code'] != 'ConditionalCheckFailedException':
                    raise