import {
    AttributeType,
    BillingMode,
    ITable,
    ProjectionType,
    StreamViewType,
    Table
} from "aws-cdk-lib/aws-dynamodb";
import { Code, Function, IFunction, Runtime, StartingPosition } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { ArnFormat, Aws, Duration, Stack } from "aws-cdk-lib";
import { AwsIotAccountEndpoint, IAwsIotAccountEndpoint } from "./AwsIotAccountEndpoint";
import { Effect, PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import {
    CfnApi,
    CfnApiMapping,
    CfnAuthorizer,
    CfnDomainName,
    CfnIntegration,
    CfnRoute,
    CfnRouteProps,
    CfnStage
} from "aws-cdk-lib/aws-apigatewayv2";
import { IPitsStorage } from "../device/PitsStorage";
import { ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import { CnameRecord, IHostedZone } from "aws-cdk-lib/aws-route53";
import { EventType } from "aws-cdk-lib/aws-s3";
import { LambdaDestination } from "aws-cdk-lib/aws-s3-notifications";
import * as path from 'path';
import { ITopic, Topic } from "aws-cdk-lib/aws-sns";
import { DynamoEventSource } from "aws-cdk-lib/aws-lambda-event-sources";

export interface PitsResourceServiceAuthorizationProps {
    readonly issuer: string,
    readonly audience: string[],
    readonly scopes?: string[]
}

export interface PitsResourceServiceProps {
    readonly apiName?: string;
    readonly table?: ITable;
    readonly topic?: ITopic;
    readonly captureImagePath?: string;
    readonly enableDevelopmentOrigin?: boolean;
    readonly authorization?: PitsResourceServiceAuthorizationProps;
    readonly dataEndpoint?: IAwsIotAccountEndpoint;
    readonly functionCode: Code;
    readonly storage: IPitsStorage;
    readonly consoleOrigin: string;
}

export interface PitsResourceServiceDomainProps {
    readonly certificate: ICertificate;
    readonly hostedZone: IHostedZone;
    readonly domainName: string;
}

export interface PitsResourceServiceNotificationProps {
    readonly baseUrl: string;
}

export interface IPitsResourceService {
    readonly table: ITable;
    readonly storage: IPitsStorage;
    readonly lambdaFunction: IFunction;
    readonly topic: ITopic;
    readonly apiId: string;
    readonly stageId: string;

    addDomain(id: string, props: PitsResourceServiceDomainProps): void;
    addNotification(id: string, props: PitsResourceServiceNotificationProps): void;
}

export class PitsResourceService extends Construct implements IPitsResourceService {
    readonly table: ITable;
    readonly storage: IPitsStorage;
    readonly lambdaFunction: IFunction;
    readonly topic: ITopic;
    readonly apiId: string;
    readonly stageId: string;

    constructor(scope: Construct, id: string, props: PitsResourceServiceProps) {
        super(scope, id);

        this.storage = props.storage;
        let table = props.table;
        let indexes = [];
        if (!table) {
            let tableImpl = new Table(this, 'Table', {
                partitionKey: {
                    name: 'PK',
                    type: AttributeType.STRING
                },
                sortKey: {
                    name: 'SK',
                    type: AttributeType. STRING
                },
                readCapacity: 1,
                writeCapacity: 1,
                billingMode: BillingMode.PROVISIONED,
                tableName: 'PitsResources',
                timeToLiveAttribute: 'expiresIn',
                stream: StreamViewType.NEW_AND_OLD_IMAGES,
            });
            let indexName = 'GS1';
            tableImpl.addGlobalSecondaryIndex({
                indexName,
                partitionKey: {
                    name: `${indexName}-PK`,
                    type: AttributeType.STRING
                },
                sortKey: {
                    name: 'createTime',
                    type: AttributeType.NUMBER
                },
                readCapacity: 1,
                writeCapacity: 1,
                projectionType: ProjectionType.ALL,
            });
            indexes.push(indexName);
            table = tableImpl;
        }
        this.table = table;
        this.topic = props.topic || new Topic(this, 'PitsNotifications', {
            topicName: "PitsNotifications",
            displayName: "Pi In The Sky",
        });

        const captureImagePath = props.captureImagePath || 'capture_images';
        this.lambdaFunction = new Function(this, 'Function', {
            runtime: Runtime.PYTHON_3_9,
            handler: 'pinthesky.resource.api',
            code: props.functionCode,
            timeout: Duration.minutes(1),
            memorySize: 512,
            environment: {
                'TABLE_NAME': this.table.tableName,
                'INDEX_NAME_1': 'GS1',
                'DATA_ENDPOINT': (props.dataEndpoint || AwsIotAccountEndpoint.dataEndpoint(this)).endpointAddress,
                'BUCKET_NAME': this.storage.bucket.bucketName,
                'IMAGE_PREFIX': captureImagePath,
                'VIDEO_PREFIX': this.storage.motionVideoConvertedPath,
                'TOPIC_ARN': this.topic.topicArn
            }
        });

        this.lambdaFunction.addToRolePolicy(new PolicyStatement({
            effect: Effect.ALLOW,
            actions: [
                'dynamodb:GetItem',
                'dynamodb:PutItem',
                'dynamodb:DeleteItem',
                'dynamodb:UpdateItem',
                'dynamodb:BatchWriteItem',
                'dynamodb:BatchGetItem',
                'dynamodb:Query',
            ],
            resources: [
                this.table.tableArn
            ]
        }));

        indexes.forEach(indexName => {
            this.lambdaFunction.addToRolePolicy(new PolicyStatement({
                effect: Effect.ALLOW,
                actions: [
                    'dynamodb:Query'
                ],
                resources: [
                    `${this.table.tableArn}/index/${indexName}`
                ]
            }));
        });

        this.lambdaFunction.addToRolePolicy(new PolicyStatement({
            effect: Effect.ALLOW,
            actions: [
                "s3:Get*"
            ],
            resources: [
                this.storage.bucket.arnForObjects(`${captureImagePath}/*`),
                this.storage.arnForMotionVideoConvertedObjects()
            ]
        }));

        this.lambdaFunction.addToRolePolicy(new PolicyStatement({
            effect: Effect.ALLOW,
            actions: [
                "sns:Subscribe"
            ],
            resources: [
                this.topic.topicArn
            ]
        }));

        this.lambdaFunction.addToRolePolicy(new PolicyStatement({
            effect: Effect.ALLOW,
            actions: [
                "s3:ListBucket"
            ],
            resources: [
                this.storage.bucket.bucketArn
            ]
        }));

        this.lambdaFunction.addToRolePolicy(new PolicyStatement({
            effect: Effect.ALLOW,
            actions: [
                // Metadata and association
                'iot:DescribeThing',
                'iot:ListThingGroups',
                'iot:ListThingsInThingGroup',
                // Events and Confiuguration
                'iot:GetThingShadow',
                'iot:UpdateThingShadow',
                'iot:Publish',
                // Jobs
                'iot:CreateJob',
                'iot:UpdateJob',
                'iot:CancelJob',
                'iot:CancelJobExecution',
                'iot:DeleteJob',
                'iot:ListJobExecutionsForJob',
                'iot:DescribeJob',
                'iot:DescribeJobExecution',
                // Notification management
                "sns:GetSubscriptionAttributes",
                "sns:SetSubscriptionAttributes",
                "sns:Unsubscribe"
            ],
            resources: [
                '*'
            ]
        }));

        let allowOrigins= [];
        if (props.enableDevelopmentOrigin === true) {
            allowOrigins.push('http://localhost:3000');
        }
        allowOrigins.push(props.consoleOrigin);
        const apiName = props.apiName || 'pits-api';
        const resourceApi = new CfnApi(this, 'HttpApi', {
            name: apiName,
            protocolType: 'HTTP',
            corsConfiguration: {
                allowCredentials: true,
                allowHeaders: [
                    'Content-Type',
                    'Content-Length',
                    'Accept',
                    'Authorization'
                ],
                allowMethods: [
                    'PUT',
                    'POST',
                    'GET',
                    'OPTIONS',
                    'DELETE'
                ],
                allowOrigins
            },
            routeSelectionExpression: '$request.method $request.path'
        });
        this.apiId = resourceApi.ref;

        const resourceIntegration = new CfnIntegration(this, 'FunctionIntegration', {
            apiId: this.apiId,
            integrationType: 'AWS_PROXY',
            connectionType: 'INTERNET',
            integrationMethod: 'POST',
            payloadFormatVersion: '2.0',
            timeoutInMillis: 30000,
            integrationUri: this.lambdaFunction.functionArn
        });

        let functionRouteProps: CfnRouteProps = {
            apiId: this.apiId,
            routeKey: '$default',
            target: `integrations/${resourceIntegration.ref}`
        };
        if (props.authorization) {
            new CfnRoute(this, 'UnauthorizedRoute', {
                apiId: this.apiId,
                routeKey: 'OPTIONS /{proxy+}',
                target: `integrations/${resourceIntegration.ref}`
            });

            const cognitoApiAuth = new CfnAuthorizer(this, 'Authorization', {
                apiId: this.apiId,
                authorizerType: 'JWT',
                identitySource: ['$request.header.Authorization'],
                jwtConfiguration: {
                    issuer: props.authorization.issuer,
                    audience: props.authorization.audience
                },
                name: `${apiName}-auth`
            });

            functionRouteProps = {
                ...functionRouteProps,
                authorizationScopes: props.authorization.scopes,
                authorizationType: 'JWT',
                authorizerId: cognitoApiAuth.ref
            };
        }

        const resourceAuthRoute = new CfnRoute(this, 'DefaultRoute', functionRouteProps);
        const resourceStage = new CfnStage(this, 'DeploymentStage', {
            apiId: this.apiId,
            stageName: '$default',
            autoDeploy: true
        });
        resourceStage.addDependency(resourceAuthRoute);
        this.stageId = resourceStage.ref;

        const stack = Stack.of(this);
        this.lambdaFunction.addPermission('api-invoke', {
            principal: new ServicePrincipal('apigateway.amazonaws.com'),
            action: 'lambda:InvokeFunction',
            sourceArn: stack.formatArn({
                service: 'execute-api',
                resource: resourceApi.ref,
                arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
                resourceName: '*/*'
            })
        });
    }

    addNotification(id: string, props: PitsResourceServiceNotificationProps): void {
        const indexFunction = new Function(this, `${id}IndexFunction`, {
            code: Code.fromAsset(path.join(__dirname, 'handlers', 'index_conversion')),
            runtime: Runtime.PYTHON_3_12,
            handler: 'index.handler',
            environment: {
                'TABLE_NAME': this.table.tableName,
                'ACCOUNT_ID': Aws.ACCOUNT_ID,
                // TODO: pull from the storage configuration
                'EXPIRE_DAYS': '180',
            },
            memorySize: 512,
            timeout: Duration.minutes(1)
        });
        indexFunction.addToRolePolicy(new PolicyStatement({
            effect: Effect.ALLOW,
            actions: [ 'dynamodb:PutItem' ],
            resources: [ this.table.tableArn ]
        }));
        indexFunction.addToRolePolicy(new PolicyStatement({
            effect: Effect.ALLOW,
            actions: [ 's3:Get*' ],
            resources: [ this.storage.arnForMotionVideoConvertedObjects() ]
        }))

        this.storage.bucket.addEventNotification(EventType.OBJECT_CREATED, new LambdaDestination(indexFunction), {
            prefix: this.storage.motionVideoConvertedPath + '/'
        });

        const notificationFunction = new Function(this, `${id}AlertFunction`, {
            code: Code.fromAsset(path.join(__dirname, 'handlers', 'publish_motion')),
            runtime: Runtime.PYTHON_3_12,
            handler: 'index.handler',
            environment: {
                'TABLE_NAME': this.table.tableName,
                'ACCOUNT_ID': Aws.ACCOUNT_ID,
                'TOPIC_ARN': this.topic.topicArn,
                'BASE_URL': props.baseUrl
            },
            memorySize: 512,
            timeout: Duration.minutes(1),
        });
        notificationFunction.addToRolePolicy(new PolicyStatement({
            effect: Effect.ALLOW,
            actions: [ 'sns:Publish' ],
            resources: [ this.topic.topicArn ]
        }));
        notificationFunction.addToRolePolicy(new PolicyStatement({
            effect: Effect.ALLOW,
            actions: [ 'dynamodb:GetItem', 'dynamodb:Query' ],
            resources: [ this.table.tableArn ]
        }));
        notificationFunction.addEventSource(new DynamoEventSource(this.table, {
            startingPosition: StartingPosition.LATEST,
            enabled: true,
            retryAttempts: 10,
            batchSize: 10,
        }));
    }

    addDomain(id: string, props: PitsResourceServiceDomainProps): void {
        const domainCreation = new CfnDomainName(this, `${id}Name`, {
            domainName: props.domainName,
            domainNameConfigurations: [
                {
                    endpointType: 'REGIONAL',
                    securityPolicy: 'TLS_1_2',
                    certificateArn: props.certificate.certificateArn
                }
            ]
        });

        const mappingResource = new CfnApiMapping(this, `${id}Mapping`, {
            apiId: this.apiId,
            stage: this.stageId,
            domainName: props.domainName
        });

        mappingResource.addDependency(domainCreation);

        new CnameRecord(this, `${id}CnameRecord`, {
            domainName: domainCreation.attrRegionalDomainName,
            zone: props.hostedZone,
            recordName: props.domainName,
            ttl: Duration.minutes(5)
        });
    }
}
