import json
import io
import base64
import boto3
import botocore
import os
from time import time
from math import floor

ddb = boto3.resource('dynamodb')
s3 = boto3.client('s3')

def handler(event, context):
    print(f'Event payload: {json.dumps(event)}')
    print(f'Event context: {context}')
    table_name = os.getenv('TABLE_NAME')
    account_id = os.getenv('ACCOUNT_ID')
    expire_days = int(os.getenv('EXPIRE_DAYS'))
    conversion_video_path = os.getenv('CONVERSION_SNAPSHOT_PATH')
    table = ddb.Table(table_name)
    for record in event['Records']:
        h_obj = s3.head_object(
            Bucket=record['s3']['bucket']['name'],
            Key=record['s3']['object']['key'])
        duration = 0
        trigger = "motion"
        if "x-amzn-meta-duration" in h_obj['Metadata']:
            duration = floor(float(h_obj['Metadata']['x-amzn-meta-duration']))
        if "x-amzn-meta-trigger" in h_obj['Metadata'] and h_obj['Metadata']['x-amzn-meta-trigger'] != 'None':
            trigger = h_obj['Metadata']['x-amzn-meta-trigger']
        split_pieces = record['s3']['object']['key'].split('/')
        thing_name = split_pieces[-2]
        video_name = split_pieces[-1]
        
        converted_thumbnail = f'{conversion_video_path}/{thing_name}/{video_name}.jpg'
        print(f'Pulling capture video {converted_thumbnail}')
        response = s3.get_object(
            Bucket=record['s3']['bucket']['name'],
            Key=converted_thumbnail)
        thumbnail_string = str(base64.b64encode(response['Body'].read()), 'utf-8')
        
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
                        'trigger': trigger,
                        'thingName': thing_name,
                        'motionVideo': video_name,
                        'duration': duration,
                        'thumbnail': thumbnail_string,
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
