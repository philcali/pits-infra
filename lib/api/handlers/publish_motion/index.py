from datetime import datetime
import json
import os
import boto3

sns = boto3.resource('sns')
ddb = boto3.resource('dynamodb')


def is_new_motion(record):
    return record['eventName'] == 'INSERT' and "MotionVideos:" in record['dynamodb']['NewImage']['PK']['S']


def camera_groups(table, account_id, thing_name):
    resp = table.query(
        KeyConditionExpression="#pk = :pk",
        ExpressionAttributeNames={"#pk": "PK"},
        ExpressionAttributeValues={":pk": f'CamerasToGroups:{account_id}:{thing_name}'}
    )
    if 'Items' in resp:
        return json.dumps([item['id'] for item in resp['Items']])
    return '[]'


def handler(event, context):
    print(f'Event payload: {json.dumps(event)}')
    print(f'Event context: {context}')
    account_id = os.getenv('ACCOUNT_ID')
    table = ddb.Table(os.getenv('TABLE_NAME'))
    topic = sns.Topic(arn=os.getenv('TOPIC_ARN'))
    base_url = os.getenv('BASE_URL')
    for record in event['Records']:
        if is_new_motion(record):
            create_time_str = record['dynamodb']['NewImage']['createTime']['N']
            create_datetime = datetime.utcfromtimestamp(int(create_time_str))
            thing_name = record['dynamodb']['NewImage']['thingName']['S']
            camera = table.get_item(Key={
                'PK': f'Cameras:{account_id}',
                'SK': thing_name
            })
            if 'Item' not in camera:
                print(f'Could not find a camera for {account_id}:{thing_name}')
                continue
            display_name = camera['Item']['displayName']
            duration = record['dynamodb']['NewImage']['duration']['N']
            video_name = record['dynamodb']['NewImage']['motionVideo']['S']
            try:
                video_link = f'{base_url}/account/videos/{video_name}/cameras/{thing_name}'
                topic.publish(
                    Subject=f'Motion detected by {display_name}',
                    Message=f'A {duration}sec motion video was recorded by {display_name} on {create_datetime.isoformat()}. Head over to {video_link} to view the entire video.',
                    MessageAttributes={
                        'Group': {
                            'DataType': 'String.Array',
                            'StringValue': camera_groups(
                                table=table,
                                account_id=account_id,
                                thing_name=thing_name
                            )
                        },
                        'Camera': {
                            'DataType': 'String',
                            'StringValue': thing_name
                        },
                        'DayOfWeek': {
                            'DataType': 'Number',
                            'StringValue': str(create_datetime.isoweekday())
                        },
                        'Hour': {
                            'DataType': 'Number',
                            'StringValue': str(create_datetime.hour)
                        }
                    }
                )
                print(f'Published {video_name} to {topic.arn}')
            except Exception as exc:
                print(f'Could not publish to {topic.arn}: {exc}')
