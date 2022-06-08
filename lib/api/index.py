from math import floor
import json
import boto3
import os


def handle_redirect(thing_name, random_string):
    ddb = boto3.resource('dynamodb')
    table = ddb.Table(os.getenv('TABLE_NAME'))
    response = table.get_item(
        Key={
            'PK': thing_name,
            'SK': random_string
        }
    )
    if "Item" not in response:
        return None
    else:
        item = response['Item']
        return {
            'statusCode': 301,
            'headers': {
                'Location': item['url']
            }
        }

def handle_no_resource():
    return {
        'statusCode': 404,
        'headers': {
            'Content-Type': 'application/json'
        },
        'body': json.dumps({
            'message': 'Resource not found.'
        })
    }

def handler(event, context):
    url = event['path'].split('/')
    response = None
    if event['httpMethod'] == 'GET' and len(url) == 3:
        response = handle_redirect(url[1], url[2])
    if response is None:
        return handle_no_resource()
    else:
        return response