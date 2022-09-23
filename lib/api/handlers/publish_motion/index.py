from datetime import datetime
import json
import os
import boto3

sns = boto3.resource('sns')
ddb = boto3.resource('dynamodb')


def is_new_motion(record, account_id):
    return record['eventName'] == 'INSERT' and f'MotionVideos:{account_id}:' in record['dynamodb']['NewImage']['PK']['S']


def is_unhealthy_bit(record, account_id):
    return record['eventName'] == 'MODIFY' and f'DeviceHealth:{account_id}:latest' == record['dynamodb']['NewImage']['PK']['S'] and record['dynamodb']['NewImage'].get('status', None) != record['dynamodb']['OldImage'].get('status', None)


def camera_groups(table, account_id, thing_name):
    resp = table.query(
        KeyConditionExpression="#pk = :pk",
        ExpressionAttributeNames={"#pk": "PK"},
        ExpressionAttributeValues={":pk": f'CamerasToGroups:{account_id}:{thing_name}'}
    )
    if 'Items' in resp:
        return json.dumps([item['id'] for item in resp['Items']])
    return '[]'


def generate_motion_alert(record, camera, create_datetime):
    base_url = os.getenv('BASE_URL')
    display_name = camera['Item']['displayName']
    duration = record['dynamodb']['NewImage']['duration']['N']
    video_name = record['dynamodb']['NewImage']['motionVideo']['S']
    video_link = f'{base_url}/account/videos/{video_name}/cameras/{camera["Item"]["thingName"]}'
    return (
        f'Motion detected by {display_name}',
        f'A {duration}sec motion video was recorded by {display_name} on {create_datetime.isoformat()}. Head over to {video_link} to view the entire video.',
        'MOTION'
    )


def generate_health_signal(record, camera, create_datetime):
    display_name = camera['Item']['displayName']
    new_status = record['dynamodb']['NewImage'].get('status', {'S': 'HEALTHY'})
    old_status = record['dynamodb']['OldImage'].get('status', {'S': 'HEALTHY'})
    return (
        f'{display_name} is now {new_status["S"]}',
        f'A change in the health of {display_name} occurred on {create_datetime.isoformat()} from {old_status["S"]} to {new_status["S"]}.',
        'HEALTH'
    )


def handler(event, context):
    print(f'Event payload: {json.dumps(event)}')
    print(f'Event context: {context}')
    account_id = os.getenv('ACCOUNT_ID')
    table = ddb.Table(os.getenv('TABLE_NAME'))
    topic = sns.Topic(arn=os.getenv('TOPIC_ARN'))
    handlers = [
        (is_new_motion, generate_motion_alert),
        (is_unhealthy_bit, generate_health_signal)
    ]
    for record in event['Records']:
        acceptable_thunks = [thunk for pred, thunk in handlers if pred(record, account_id)]
        for payload_thunk in acceptable_thunks:
            create_time_str = record['dynamodb']['NewImage']['updateTime']['N']
            create_datetime = datetime.utcfromtimestamp(int(create_time_str))
            thing_name = record['dynamodb']['NewImage']['thingName']['S']
            camera = table.get_item(Key={
                'PK': f'Cameras:{account_id}',
                'SK': thing_name
            })
            if 'Item' not in camera:
                print(f'Could not find a camera for {account_id}:{thing_name}')
                continue
            try:
                subject, message, alert_type = payload_thunk(record, camera, create_datetime)
                topic.publish(
                    Subject=subject,
                    Message=message,
                    MessageAttributes={
                        'AlertType': {
                            'DataType': 'String',
                            'StringValue': alert_type
                        },
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
                print(f'Published {thing_name} to {topic.arn}')
            except Exception as exc:
                print(f'Could not publish to {topic.arn}: {exc}')
