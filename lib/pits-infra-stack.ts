import * as path from 'path'
import { ArnFormat, Aws, Duration, Stack, StackProps } from 'aws-cdk-lib';
import { Effect, FederatedPrincipal, ManagedPolicy, PolicyDocument, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { EcrImageCode, Function, Handler, Runtime } from 'aws-cdk-lib/aws-lambda';
import { Bucket, EventType } from 'aws-cdk-lib/aws-s3';
import { LambdaDestination } from 'aws-cdk-lib/aws-s3-notifications';
import { AwsCustomResource, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { DockerImageAsset } from 'aws-cdk-lib/aws-ecr-assets';
import { ARecord, CnameRecord, HostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { DockerImageName, ECRDeployment } from 'cdk-ecr-deployment';
import { Repository, RepositoryEncryption } from 'aws-cdk-lib/aws-ecr';
import {
  AccountRecovery,
  CfnIdentityPool,
  CfnIdentityPoolRoleAttachment,
  ClientAttributes,
  Mfa, OAuthScope,
  UserPool,
  UserPoolClientIdentityProvider,
  UserPoolEmail
} from 'aws-cdk-lib/aws-cognito';

const ZONE_ID = 'Z2DL6AR506I4EE';
const CERTIFICATE_ID = 'f2674298-1642-4284-a9a6-e90b8803ff6e';

export class PitsInfraStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const bucketName = 'philcali-pinthesky-storage';
    const storage = new Bucket(this, 'PitsStorage', {
      bucketName
    });

    const conversionImage = new DockerImageAsset(this, 'PitsConvertImage', {
      directory: path.join(__dirname, 'image')
    });

    const ecrRepoName = 'pits-convert';
    const ecrRepo = new Repository(this, 'PitsConvertECR', {
      encryption: RepositoryEncryption.AES_256,
      repositoryName: ecrRepoName,

    });

    const conversionEcrDeployment = new ECRDeployment(this, 'PitsConvertECRDeployment', {
      src: new DockerImageName(conversionImage.imageUri),
      dest: new DockerImageName(`${Aws.ACCOUNT_ID}.dkr.ecr.${Aws.REGION}.amazonaws.com/${ecrRepo.repositoryName}:latest`)
    });

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

    storage.addEventNotification(EventType.OBJECT_CREATED, new LambdaDestination(conversionFunction), {
      prefix: 'motion_videos/'
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

    const pitsDomain = new ARecord(this, 'PitsARecord', {
      zone: hostedZone,
      target: RecordTarget.fromIpAddresses('198.51.100.1')
    });

    const userPool = new UserPool(this, 'PitsUserPool', {
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      selfSignUpEnabled: false,
      userPoolName: 'pinthesky-users',
      email: UserPoolEmail.withCognito('noreply@verificationemail.com'),
      enableSmsRole: false,
      signInCaseSensitive: false,
      mfa: Mfa.OPTIONAL,
      mfaSecondFactor: {
        otp: true,
        sms: false
      },
      passwordPolicy: {
        minLength: 12,
        requireSymbols: true,
        requireDigits: true
      },
      signInAliases: {
        username: true,
        email: true
      }
    });

    userPool.node.addDependency(pitsDomain);

    const writeAttributes = new ClientAttributes()
      .withStandardAttributes({ fullname: true, email: true });
    const readAttributes = writeAttributes
      .withStandardAttributes({ emailVerified: true });

    const userPoolClient = userPool.addClient('Client', {
      generateSecret: true,
      authFlows: {
        userSrp: true,
        userPassword: true
      },
      enableTokenRevocation: true,
      accessTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      readAttributes,
      writeAttributes,
      userPoolClientName: 'pits-app-client',
      supportedIdentityProviders: [
        UserPoolClientIdentityProvider.COGNITO
      ],
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
          implicitCodeGrant: true
        },
        scopes: [
          OAuthScope.OPENID,
          OAuthScope.PROFILE,
          OAuthScope.EMAIL
        ],
        callbackUrls: [
          'http://localhost:8080/login',
          'https://api.pinthesky.com/login'
        ],
        logoutUrls: [
          'http://localhost:8080/logout',
          'https://api.pinthesky.com/logout'
        ]
      }
    });

    userPool.addDomain('Domain', {
      cognitoDomain: {
        domainPrefix: 'pinthesky'
      }
    });

    const customAuthDomain = userPool.addDomain('CustomDomain', {
      customDomain: {
        certificate,
        domainName: 'auth.pinthesky.com'
      }
    });

    new CnameRecord(this, 'PitsAuthAliasRecord', {
      zone: hostedZone,
      domainName: customAuthDomain.cloudFrontDomainName,
      recordName: 'auth.pinthesky.com'
    });

    const identityPool = new CfnIdentityPool(this, 'PitsIdentityPool', {
      identityPoolName: 'pinthesky-identities',
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [
        {
          clientId: userPoolClient.userPoolClientId,
          providerName: userPool.userPoolProviderName
        }
      ]
    });

    const cognitoPrincipal = "cognito-identity.amazonaws.com";
    const authenticatedUser = new Role(this, 'PitsAuthenticatedRole', {
      roleName: 'pinthesky-auth-role',
      assumedBy: new FederatedPrincipal(cognitoPrincipal, {
        "StringEquals": {
          [`${cognitoPrincipal}:aud`]: `${Aws.REGION}:${identityPool.ref}`
        },
        "ForAnyValue:StringLike": {
          [`${cognitoPrincipal}:amr`]: "authenticated"
        }
      }, "sts:AssumeRoleWithWebIdentity")
    });

    new ManagedPolicy(this, 'PitsAuthenticatedPolicy', {
      roles: [ authenticatedUser ],
      managedPolicyName: 'pinthesky-auth-policy',
      document: new PolicyDocument({
        statements: [
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: [
              "mobileanalytics:PutEvents",
              "cognito-identity:*",
              "cognito-sync:*"
            ],
            resources: [
              "*"
            ]
          })
        ]
      })
    });

    new CfnIdentityPoolRoleAttachment(this, 'PitsAuthenticatedAttachment', {
      identityPoolId: identityPool.ref,
      roles: {
        "authenticated": authenticatedUser.roleArn
      },
      roleMappings: {
        "pinthesky-users": {
          type: "Token",
          ambiguousRoleResolution: "AuthenticatedRole",
          identityProvider: `${userPool.userPoolProviderName}:${userPoolClient.userPoolClientId}`
        }
      }
    });

    // Below is the AWS IoT stuff... needs a construct
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
