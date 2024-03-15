import boto3
import botocore
import os
import urllib
import json
import time
from math import floor


PITS_TAGS = "https://api.github.com/repos/philcali/pits-device/tags"
ddb = boto3.resource('dynamodb')


def handler(event, context):
    table_name = os.getenv("TABLE_NAME")
    account_id = os.getenv("ACCOUNT_ID")
    table = ddb.Table(table_name)
    with urllib.request.urlopen(PITS_TAGS) as resp:
        content = resp.read()
    
    tags = json.loads(content.decode('utf-8'))
    if len(tags) == 0:
        print(f'Could not find any versions?')
        raise RuntimeError()

    latest_tag = tags[0]
    create_item = floor(time.time())
    try:
        table.put_item(
            Item={
                'PK': f'Versions:{account_id}:latest',
                'SK': 'current',
                'tag': latest_tag['name'],
                'commit': latest_tag['commit'],
                'createTime': create_item,
                'updateTime': create_item,
            },
            ConditionExpression='#tag <> :tag',
            ExpressionAttributeNames={'#tag': 'tag'},
            ExpressionAttributeValues={':tag': latest_tag['name']}
        )
        print(f'Found a new software version {latest_tag["name"]}')
    except botocore.exceptions.ClientError as e:
        if e.response['Error']['Code'] != 'ConditionalCheckFailedException':
            raise
        print(f'Existing software did not change from {latest_tag["name"]}')

    for tag in tags:
        try:
            table.put_item(
                Item={
                    'PK': f'Versions:{account_id}',
                    'SK': tag['name'],
                    'name': tag['name'],
                    'commit': tag['commit'],
                    'createTime': create_item,
                    'updateTime': create_item,
                },
                ConditionExpression='attribute_not_exists(PK) AND attribute_not_exists(SK)',
            )
            print(f'Successfully indexed software version {tag["name"]}')
        except botocore.exceptions.ClientError as e:
            if e.response['Error']['Code'] != 'ConditionalCheckFailedException':
                raise
            print(f'Already indexed software version {tag["name"]}')
