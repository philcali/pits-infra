from datetime import datetime
import json
from math import floor
import os
import boto3

ddb = boto3.resource('dynamodb')


def query_latest_health(table, account_id):
    resp = table.query(
        KeyConditionExpression="#pk = :pk",
        ExpressionAttributeNames={"#pk": "PK"},
        ExpressionAttributeValues={":pk": f'DeviceHealth:{account_id}:latest'}
    )
    return resp.get('Items', [])


def handler(event, context):
    print(f'Event payload: {json.dumps(event)}')
    print(f'Event context: {context}')
    table = ddb.Table(os.getenv('TABLE_NAME'))
    rate = int(os.getenv('RATE_IN_SECONDS'))
    account_id = os.getenv('ACCOUNT_ID')
    now = datetime.utcnow()
    for item in query_latest_health(table, account_id):
        create_time = datetime.utcfromtimestamp(float(item['createTime']))
        delta = now - create_time
        if delta.total_seconds() > rate:
            item['status'] = 'UNHEALTHY'
            item['thingName'] = item['thing_name']
            item['updateTime'] = floor(now.timestamp())
            # TODO: update the historical one...?
            table.put_item(Item=item)
