import * as path from 'path'
import { ArnFormat,Aws,Duration, Stack, StackProps } from 'aws-cdk-lib';
import { Effect, ManagedPolicy, PolicyDocument, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Code, EcrImageCode, Function, Handler, Runtime } from 'aws-cdk-lib/aws-lambda';
import { Bucket, EventType } from 'aws-cdk-lib/aws-s3';
import { LambdaDestination } from 'aws-cdk-lib/aws-s3-notifications';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { AwsCustomResource, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { LambdaRestApi } from 'aws-cdk-lib/aws-apigateway';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { DockerImageAsset } from 'aws-cdk-lib/aws-ecr-assets';
import { CnameRecord, HostedZone } from 'aws-cdk-lib/aws-route53';
import { DockerImageName, ECRDeployment } from 'cdk-ecr-deployment';
import { Repository, RepositoryEncryption } from 'aws-cdk-lib/aws-ecr';

const ZONE_ID = 'Z2DL6AR506I4EE';
const CERTIFICATE_ID = 'f2674298-1642-4284-a9a6-e90b8803ff6e';

export class PitsInfraStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const bucketName = 'philcali-pinthesky-storage';
    const storage = new Bucket(this, 'PitsStorage', {
      bucketName
    });

    const notification = new Topic(this, 'PitsTopic', {
      displayName: "Pi In The Sky",
    });

    const conversionImage = new DockerImageAsset(this, 'PitsConvertImage', {
      directory: path.join(__dirname, 'image')
    });

    const ecrRepoName = 'pits-convert';
    const ecrRepo = new Repository(this, 'PitsConvertECR', {
      encryption: RepositoryEncryption.AES_256,
      repositoryName: ecrRepoName,

    })
    const conversionEcrDeployment = new ECRDeployment(this, 'PitsConvertECRDeployment', {
      src: new DockerImageName(conversionImage.imageUri),
      dest: new DockerImageName(`${Aws.ACCOUNT_ID}.dkr.ecr.${Aws.REGION}.amazonaws.com/${ecrRepo.repositoryName}:latest`)
    })

    const pitsTable = new Table(this, 'PitsDataTable', {
      tableName: 'PitsTable',
      partitionKey: {
        type: AttributeType.STRING,
        name: 'PK'
      },
      sortKey: {
        type: AttributeType.STRING,
        name: 'SK'
      },
      timeToLiveAttribute: 'expiresIn',
      billingMode: BillingMode.PROVISIONED,
      readCapacity: 1,
      writeCapacity: 1
    });

    const domainName = 'url.pinthesky.com';
    const conversionFunction = new Function(this, 'PitsConvertFunction', {
      handler: Handler.FROM_IMAGE,
      runtime: Runtime.FROM_IMAGE,
      code: new EcrImageCode(ecrRepo),
      environment: {
        'CONVERSION_FORMAT': 'mp4',
        'FRAMERATE': '15'
      },
      memorySize: 1024,
      timeout: Duration.minutes(2)
    });
    conversionFunction.node.addDependency(conversionEcrDeployment);
    conversionFunction.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        's3:GetObject'
      ],
      resources: [
        storage.arnForObjects("motion_videos/*")
      ]
    }));
    conversionFunction.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        's3:PutObject'
      ],
      resources: [
        storage.arnForObjects("motion_videos_converted/*")
      ]
    }));
    const formatMessage = new Function(this, 'PitsFormat', {
      handler: 'index.handler',
      runtime: Runtime.PYTHON_3_9,
      code: Code.fromAsset(path.join(__dirname, 'handler')),
      environment: {
        'NOTIFICATION_TOPIC_ARN': notification.topicArn,
        'TABLE_NAME': pitsTable.tableName,
        'DOMAIN_NAME': domainName
      }
    });

    formatMessage.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        's3:GetObject'
      ],
      resources: [
        storage.arnForObjects("motion_videos_converted/*")
      ]
    }));

    formatMessage.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        'sns:Publish'
      ],
      resources: [
        notification.topicArn
      ]
    }));

    formatMessage.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        'dynamodb:PutItem'
      ],
      resources: [
        pitsTable.tableArn        
      ]
    }));

    storage.addEventNotification(EventType.OBJECT_CREATED, new LambdaDestination(conversionFunction), {
      prefix: 'motion_videos/'
    })

    storage.addEventNotification(EventType.OBJECT_CREATED, new LambdaDestination(formatMessage), {
      prefix: 'motion_videos_converted/'
    });

    const apiHandler = new Function(this, 'PitsShortenerHandler', {
      handler: 'index.handler',
      runtime: Runtime.PYTHON_3_9,
      code: Code.fromAsset(path.join(__dirname, 'api')),
      environment: {
        'TABLE_NAME': pitsTable.tableName
      }
    });

    apiHandler.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        'dynamodb:GetItem'
      ],
      resources: [
        pitsTable.tableArn
      ]
    }));

    const restApi = new LambdaRestApi(this, 'PitsURLShortener', {
      deployOptions: {
        stageName: 'v1'
      },
      handler: apiHandler
    });

    const certificate = Certificate.fromCertificateArn(this, 'PitsShortenerCertificate', this.formatArn({
      service: 'acm',
      resource: 'certificate',
      resourceName: CERTIFICATE_ID,
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME
    }));

    const hostedZone = HostedZone.fromHostedZoneAttributes(this, 'PitsHostedZone', {
      hostedZoneId: ZONE_ID,
      zoneName: 'pinthesky.com'
    });

    const apiDomainName = restApi.addDomainName('PitsShortenerDomain', {
      domainName,
      certificate
    });

    new CnameRecord(this, 'PitsShortenerCNAME', {
      domainName: apiDomainName.domainNameAliasDomainName,
      zone: hostedZone,
      recordName: domainName,
      ttl: Duration.minutes(30)
    });

    const pitsRole = new Role(this, 'PitsRole', {
      roleName: 'PinTheSkyRole',
      assumedBy: new ServicePrincipal('credentials.iot.amazonaws.com')
    });

    new ManagedPolicy(this, 'PitsUploadPolicy', {
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

    new AwsCustomResource(this, 'PitsThingPolicy', {
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
