import json
import boto3
import botocore
import os
from time import time
from math import floor

def handler(event, context):
    print(f'Event payload: {json.dumps(event)}')
    print(f'Event context: {context}')
    ddb = boto3.resource('dynamodb')
    table_name = os.getenv('TABLE_NAME')
    account_id = os.getenv('ACCOUNT_ID')
    expire_days = int(os.getenv('EXPIRE_DAYS'))
    table = ddb.Table(table_name)
    for record in event['Records']:
        split_pieces = record['s3']['object']['key'].split('/')
        thing_name = split_pieces[-2]
        video_name = split_pieces[-1]
        attempt = 0
        while attempt < 3:
            attempt += 1
            try:
                creation_time = floor(time())
                table.put_item(
                    Item={
                        'PK': f'MotionVideos:{account_id}:{thing_name}',
                        'SK': video_name,
                        'GS1-PK': f'MotionVideos:{account_id}',
                        'thingName': thing_name,
                        'motionVideo': video_name,
                        'createTime': creation_time,
                        'updateTime': creation_time,
                        'expiresIn': creation_time + (60 * 60 * 24 * expire_days)
                    },
                    ConditionExpression='attribute_not_exists(PK) AND attribute_not_exists(SK)')
                print(f'Successfully indexed s3://{record["s3"]["bucket"]["name"]}/{record["s3"]["object"]["key"]}')
                break
            except botocore.exceptions.ClientError as e:
                if e.response['Error']['Code'] != 'ConditionalCheckFailedException':
                    raise