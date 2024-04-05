import { ArnFormat, Aws, Duration, Stack } from "aws-cdk-lib";
import { CfnApi, CfnApiMapping, CfnAuthorizer, CfnDomainName, CfnIntegration, CfnRoute, CfnRouteProps, CfnStage } from "aws-cdk-lib/aws-apigatewayv2";
import { ITable } from "aws-cdk-lib/aws-dynamodb";
import { Effect, IManagedPolicy, IRole, ManagedPolicy, PolicyDocument, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Code, Function, IFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { AwsIotAccountEndpoint, IAwsIotAccountEndpoint } from "../api/AwsIotAccountEndpoint";
import { PitsResourceServiceDomainProps } from "../api/PitsResourceService";
import { CnameRecord } from "aws-cdk-lib/aws-route53";

type RoleLike = IRole | string;

export interface PitsDataResourceAuthorizationProps {
    readonly userPoolId: string;
    readonly clientId: string;
}

export interface PitsDataResourceProps {
    readonly name?: string;
    readonly table: ITable;
    readonly functionCode: Code;
    readonly allowedManagementRoles?: RoleLike[];
    readonly authorization: PitsDataResourceAuthorizationProps;
    readonly dataEndpoint?: IAwsIotAccountEndpoint;
}

export interface IPitsDataService {
    readonly apiId: string
    readonly stageId: string

    addDomain(id: string, props: PitsResourceServiceDomainProps): void;
    createConnectionPolicy(): PolicyStatement;
}

export class PitsDataService extends Construct implements IPitsDataService {
    readonly lambdaFunction: IFunction;
    readonly apiId: string;
    readonly stageId: string;

    constructor(scope: Construct, id: string, props: PitsDataResourceProps) {
        super(scope, id);

        const commonProps = {
            runtime: Runtime.PYTHON_3_9,
            code: props.functionCode,
            memorySize: 512,
            timeout: Duration.seconds(30),
            environment: {
                'TABLE_NAME': props.table.tableName,
                'INDEX_NAME_1': 'GS1',
                'DATA_ENDPOINT': (props.dataEndpoint ?? AwsIotAccountEndpoint.dataEndpoint(this)).endpointAddress,
                'ACCOUNT_ID': Aws.ACCOUNT_ID,
            }
        }

        const socketHandler = new Function(this, 'SocketFunction', {
            ...commonProps,
            handler: 'pinthesky.resource.api',
        });

        const authorizerHandler = new Function(this, 'AuthorizerFunction', {
            ...commonProps,
            handler: 'pinthesky.auth.user_jwt',
            environment: {
                ...commonProps.environment,
                'USER_POOL_ID': props.authorization.userPoolId,
                'USER_CLIENT_ID': props.authorization.clientId,
            }
        });

        socketHandler.addToRolePolicy(new PolicyStatement({
            effect: Effect.ALLOW,
            actions: [
                'dynamodb:GetItem',
                'dynamodb:PutItem',
                'dynamodb:DeleteItem',
                'dynamodb:Query'
            ],
            resources: [
                props.table.tableArn
            ]
        }));

        socketHandler.addToRolePolicy(new PolicyStatement({
            effect: Effect.ALLOW,
            actions: [
                'iot:Publish'
            ],
            resources: [
                '*'
            ]
        }))

        const name = props.name ?? 'pits-data';
        const resourceApi = new CfnApi(this, 'WebsocketApi', {
            name,
            protocolType: 'WEBSOCKET',
            routeSelectionExpression: '$request.body.action',
        });
        this.apiId = resourceApi.ref;

        const managementRoles = props.allowedManagementRoles?.map(roleLike => {
            if (typeof roleLike === 'string') {
                return Role.fromRoleName(this, roleLike, roleLike);
            } else {
                return roleLike;
            }
        })

        new ManagedPolicy(this, 'ConnectionPolicy', {
            statements: [this.createConnectionPolicy()],
            roles: [
                socketHandler.role as IRole,
                ...(managementRoles ?? [])
            ],
        });

        const credentialsRole = new Role(this, 'CredentialsRole', {
            assumedBy: new ServicePrincipal('apigateway.amazonaws.com'),
            inlinePolicies: {
                'execution': new PolicyDocument({
                    statements: [
                        new PolicyStatement({
                            effect: Effect.ALLOW,
                            actions: [
                                'logs:CreateLogGroup',
                                'logs:CreateLogStream',
                                'logs:PutLogEvents',
                            ],
                            resources: [
                                '*'
                            ]
                        }),
                        new PolicyStatement({
                            effect: Effect.ALLOW,
                            actions: [
                                'lambda:InvokeFunction',
                            ],
                            resources: [
                                '*'
                            ]
                        })
                    ]
                })
            }
        });

        const routes = [
            '$connect',
            '$disconnect',
            '$default',
            'invoke',
        ].map(route => {
            let integrationUri = `arn:${Aws.PARTITION}:apigateway:${Aws.REGION}:lambda:path/2015-03-31/functions/${socketHandler.functionArn}/invocations`;
            const routeKey = route.replace('$', '');
            const integration = new CfnIntegration(this, `${routeKey}Integration`, {
                apiId: resourceApi.ref,
                integrationUri,
                integrationType: 'AWS_PROXY',
                integrationMethod: 'POST',
                credentialsArn: credentialsRole.roleArn
            });

            let routeProps: CfnRouteProps = {
                apiId: resourceApi.ref,
                routeKey: route,
                target: `integrations/${integration.ref}`,
            };

            if (routeKey === 'connect' ) {
                integrationUri = `arn:${Aws.PARTITION}:apigateway:${Aws.REGION}:lambda:path/2015-03-31/functions/${authorizerHandler.functionArn}/invocations`;
                const authorizer = new CfnAuthorizer(this, `${routeKey}Authorizer`, {
                    apiId: resourceApi.ref,
                    authorizerType: 'REQUEST',
                    name: `${name}-auth`,
                    identitySource: ['route.request.header.Authorization'],
                    authorizerCredentialsArn: credentialsRole.roleArn,
                    authorizerUri: integrationUri,
                });

                routeProps = {
                    ...routeProps,
                    authorizationType: 'CUSTOM',
                    authorizerId: authorizer.ref
                }
            }

            return new CfnRoute(this, `${routeKey}Route`, {
                ...routeProps,
            })
        });

        const resourceStage = new CfnStage(this, 'DeploymentStage', {
            apiId: resourceApi.ref,
            stageName: '$default',
            autoDeploy: true,
        });

        routes.forEach(route => {
            resourceStage.addDependency(route);
        });

        [ authorizerHandler, socketHandler ].forEach(func => func.addPermission('SocketPermission', {
            principal: new ServicePrincipal('apigateway.amazonaws.com'),
            action: 'lambda:InvokeFunction',
            sourceArn: Stack.of(this).formatArn({
                service: 'execute-api',
                resource: resourceApi.ref,
                arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
                resourceName: '*/*',
            })
        }))

        this.stageId = resourceStage.ref;
    }

    createConnectionPolicy(): PolicyStatement {
        return new PolicyStatement({
            effect: Effect.ALLOW,
            actions: [
                'execute-api:Invoke',
                'execute-api:ManageConnections'
            ],
            resources: [
                Stack.of(this).formatArn({
                    service: 'execute-api',
                    arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
                    resource: this.apiId,
                    resourceName: '*',
                })
            ]
        })
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

        const mappingResource = new CfnApiMapping(this, `${id}MApping`, {
            apiId: this.apiId,
            stage: this.stageId,
            domainName: props.domainName,
        });

        mappingResource.addDependency(domainCreation);

        new CnameRecord(this, `${id}CnameRecord`, {
            domainName: domainCreation.attrRegionalDomainName,
            zone: props.hostedZone,
            recordName: props.domainName,
            ttl: Duration.minutes(5),
        })
    }
}