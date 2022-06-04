import { aws_iot, Stack, StackProps } from 'aws-cdk-lib';
import { Effect, ManagedPolicy, PolicyDocument, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { AwsCustomResource, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export class PitsInfraStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const bucketName = 'philcali-pinthesky-storage';
    const storage = new Bucket(this, 'PitsStorage', {
      bucketName
    })

    const pitsRole = new Role(this, 'PitsRole', {
      roleName: 'PinTheSkyRole',
      assumedBy: new ServicePrincipal('credentials.iot.amazonaws.com')
    });

    const putPolicy = new ManagedPolicy(this, 'PitsUploadPolicy', {
      managedPolicyName: 'philcali-pinthesky-storage-policy',
      document: new PolicyDocument({
        statements: [
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: [
              's3:PutObject*',
              's3:Abort*'
            ],
            resources: [
              storage.bucketArn + "/motion_videos/*"
            ]
          })
        ]
      }),
      roles: [ pitsRole ]
    });

    const roleAliasName = 'PinTheSkyRoleAlias';
    const roleAlias = new AwsCustomResource(this, 'PitsRoleAlias', {
      policy: {
        statements: [
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: [
              'iot:CreateRoleAlias',
              'iot:DeleteRoleAlias'
            ],
            resources: [
              this.formatArn({
                service: 'iot',
                resource: `rolealias/${roleAliasName}`
              })
            ]
          }),
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: [
              'iam:PassRole',
              'iam:GetRole'
            ],
            resources: [
              pitsRole.roleArn
            ]
          })
        ]
      },
      onCreate: {
        physicalResourceId: PhysicalResourceId.of(roleAliasName),
        service: 'Iot',
        action: 'createRoleAlias',
        parameters: {
          roleAlias: roleAliasName,
          roleArn: pitsRole.roleArn
        }
      },
      onDelete: {
        physicalResourceId: PhysicalResourceId.of(roleAliasName),
        service: 'Iot',
        action: 'deleteRoleAlias',
        parameters: {
          roleAlias: roleAliasName
        }
      }
    });

    const policyName = 'PinTheSkyThingPolicy';
    const policyDocument = {
      "Version": "2012-10-17",
      "Statement": [
        {
          "Effect": "Allow",
          "Action": [
            "iot:Connect"
          ],
          "Resource": [
            this.formatArn({
              service: 'iot',
              resource: "client/${iot:Connection.Thing.ThingName}"
            })
          ]
        },
        {
          "Effect": "Allow",
          "Action": [
            "iot:Publish"
          ],
          "Resource": [
            // Software events
            this.formatArn({
              service: 'iot',
              resource: 'topic/pinthesky/events/output'
            }),
            // Runtime configuration updates
            this.formatArn({
              service: 'iot',
              resource: 'topic/$aws/things/${iot:Connection.Thing.ThingName}/shadow/name/pinthesky/*'
            }),
            // Jobs software updates
            this.formatArn({
              service: 'iot',
              resource: 'topic/$aws/things/${iot:Connection.Thing.ThingName}/jobs/*'
            })
          ]
        },
        {
          "Effect": "Allow",
          "Action": [
            "iot:Subscribe"
          ],
          "Resource": [
            // Remote control events
            this.formatArn({
              service: 'iot',
              resource: 'topicfilter/pinthesky/events/${iot:Connection.Thing.ThingName}/input'
            }),
            // Configuration changes
            this.formatArn({
              service: 'iot',
              resource: 'topicfilter/$aws/things/${iot:Connection.Thing.ThingName}/shadow/name/pinthesky/*'
            }),
            // Software updates
            this.formatArn({
              service: 'iot',
              resource: 'topicfilter/$aws/things/${iot:Connection.Thing.ThingName}/jobs/*'
            })
          ]
        },
        {
          "Effect": "Allow",
          "Action": [
            "iot:Receive"
          ],
          "Resource": [
            // Remote control events
            this.formatArn({
              service: 'iot',
              resource: 'topic/pinthesky/events/${iot:Connection.Thing.ThingName}/input'
            }),
            // Configuration changes
            this.formatArn({
              service: 'iot',
              resource: 'topic/$aws/things/${iot:Connection.Thing.ThingName}/shadow/name/pinthesky/*'
            }),
            // Software updates
            this.formatArn({
              service: 'iot',
              resource: 'topic/$aws/things/${iot:Connection.Thing.ThingName}/jobs/*'
            })
          ]
        },
        {
          "Effect": "Allow",
          "Action": [
            "iot:AssumeRoleWithCertificate"
          ],
          "Resource": [
            roleAlias.getResponseField("roleAliasArn")
          ]
        }
      ] 
    };

    const thingPolicy = new AwsCustomResource(this, 'PitsThingPolicy', {
      policy: {
        statements: [
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: [
              'iot:CreatePolicy',
              'iot:CreatePolicyVersion',
              'iot:DeletePolicy'
            ],
            resources: [
              this.formatArn({
                service: 'iot',
                resource: `policy/${policyName}`
              })
            ]
          })
        ]
      },
      onCreate: {
        physicalResourceId: PhysicalResourceId.of(policyName),
        service: 'Iot',
        action: 'createPolicy',
        parameters: {
          policyName,
          policyDocument: JSON.stringify(policyDocument)
        }
      },
      onUpdate: {
        physicalResourceId: PhysicalResourceId.of(policyName),
        service: 'Iot',
        action: 'createPolicyVersion',
        parameters: {
          policyName,
          policyDocument: JSON.stringify(policyDocument),
          setAsDefault: true
        }
      },
      onDelete: {
        physicalResourceId: PhysicalResourceId.of(policyName),
        service: 'Iot',
        action: 'deletePolicy',
        parameters: {
          policyName
        }
      }
    });
  }
}
