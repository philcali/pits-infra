import {
    AttributeType,
    BillingMode,
    ITable,
    Table
} from "aws-cdk-lib/aws-dynamodb";
import { Code, Function, IFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { ArnFormat, AssetHashType, Duration, Stack } from "aws-cdk-lib";
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
import * as path from 'path';
import * as child from 'child_process';
import * as fs from 'fs';

export interface PitsResourceServiceAuthorizationProps {
    readonly issuer: string,
    readonly audience: string[],
    readonly scopes?: string[]
}

export interface PitsResourceServiceProps {
    readonly apiName?: string;
    readonly functionCode?: Code;
    readonly table?: ITable;
    readonly captureImagePath?: string;
    readonly enableDevelopmentOrigin?: boolean;
    readonly authorization?: PitsResourceServiceAuthorizationProps;
    readonly dataEndpoint?: IAwsIotAccountEndpoint;
    readonly storage: IPitsStorage;
    readonly consoleOrigin: string;
}

export interface PitsResourceServiceDomainProps {
    readonly certificate: ICertificate;
    readonly hostedZone: IHostedZone;
    readonly domainName: string;
}

export interface IPitsResourceService {
    readonly table: ITable;
    readonly storage: IPitsStorage;
    readonly lambdaFunction: IFunction;
    readonly apiId: string;
    readonly stageId: string;

    addDomain(id: string, props: PitsResourceServiceDomainProps): void;
}

interface BuildOutput {
    assestHash: string,
    archive: string
}

function apiBuild(buildPath: string): BuildOutput {
    child.execSync('./dev.make-zip.sh', {
        cwd: buildPath,
    });
    return {
        archive: path.join(__dirname, 'build', 'build_function.zip'),
        assestHash: child.execSync("git submodule status | sed -E 's|([0-9A-Za-z]+) .*|\\1|'").toString('utf-8').trim()
    };
}

export class PitsResourceService extends Construct implements IPitsResourceService {
    readonly table: ITable;
    readonly storage: IPitsStorage;
    readonly lambdaFunction: IFunction;
    readonly apiId: string;
    readonly stageId: string;

    constructor(scope: Construct, id: string, props: PitsResourceServiceProps) {
        super(scope, id);

        this.storage = props.storage;
        this.table = props.table || new Table(this, 'Table', {
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
            tableName: 'PitsResources'
        });

        let code = props.functionCode;
        if (typeof code === 'undefined') {
            let buildArchive = apiBuild(path.join(__dirname, 'build'));
            code = Code.fromAsset(buildArchive.archive, {
                assetHash: buildArchive.assestHash,
            });
        }
        const captureImagePath = props.captureImagePath || 'capture_images'
        this.lambdaFunction = new Function(this, 'Function', {
            runtime: Runtime.PYTHON_3_9,
            handler: 'pinthesky.resource.api',
            code,
            timeout: Duration.minutes(1),
            memorySize: 512,
            environment: {
                'TABLE_NAME': this.table.tableName,
                'DATA_ENDPOINT': (props.dataEndpoint || AwsIotAccountEndpoint.dataEndpoint(this)).endpointAddress,
                'BUCKET_NAME': this.storage.bucket.bucketName,
                'IMAGE_PREFIX': captureImagePath
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
                'dynamodb:Query',
            ],
            resources: [
                this.table.tableArn
            ]
        }));

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
                'iot:DescribeThing',
                'iot:ListThingGroups',
                'iot:ListThingsInThingGroup',
                'iot:GetThingShadow',
                'iot:UpdateThingShadow',
                'iot:Publish',
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
        resourceStage.addDependsOn(resourceAuthRoute);
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

        mappingResource.addDependsOn(domainCreation);

        new CnameRecord(this, `${id}CnameRecord`, {
            domainName: domainCreation.attrRegionalDomainName,
            zone: props.hostedZone,
            recordName: props.domainName,
            ttl: Duration.minutes(5)
        });
    }
}