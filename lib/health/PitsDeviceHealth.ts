import { ArnFormat, Duration, Stack } from "aws-cdk-lib";
import { ITable } from "aws-cdk-lib/aws-dynamodb";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import { Effect, IRole, PolicyDocument, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnTopicRule } from "aws-cdk-lib/aws-iot";
import { Code, Function, Runtime } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import * as path from 'path';

export interface PitsDeviceHealthProps {
    readonly inputTopic?: string;
    readonly ruleSqlVersion?: string;
    readonly table: ITable;
    readonly expiresDuration?: Duration;
}

export interface PitsHealthTimeoutProps {
    readonly timeout?: Duration;
}

export interface IPitsDeviceHealth {
    readonly rulesRole: IRole;
    readonly updateLatestRuleName: string;
    readonly updateIndexRuleName: string;

    addHealthTimeout(id: string, props?: PitsHealthTimeoutProps): void;
}

export class PitsDeviceHealth extends Construct implements IPitsDeviceHealth {
    readonly rulesRole: IRole;
    readonly updateLatestRuleName: string;
    readonly updateIndexRuleName: string;
    readonly republishRuleName: string;

    private readonly table: ITable;

    constructor(scope: Construct, id: string, props: PitsDeviceHealthProps) {
        super(scope, id);

        this.table = props.table;
        this.republishRuleName = `${id}RuleFanOut`;
        this.updateLatestRuleName = `${id}RuleLatest`;
        this.updateIndexRuleName = `${id}RuleIndex`;
        const inputTopic = props.inputTopic || 'pinthesky/events/output';
        const republishTopics = [ this.updateLatestRuleName, this.updateIndexRuleName ];
        const stack = Stack.of(this);
        this.rulesRole = new Role(this, 'Role', {
            assumedBy: new ServicePrincipal('iot.amazonaws.com'),
            inlinePolicies: {
                'RepublishAndIndex': new PolicyDocument({
                    statements: [
                        new PolicyStatement({
                            effect: Effect.ALLOW,
                            actions: [
                                'iot:Publish'
                            ],
                            resources: [
                                stack.formatArn({
                                    service: 'iot',
                                    resource: 'topic',
                                    arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
                                    resourceName: `${inputTopic}/error`
                                }),
                                ...republishTopics.map(postfix => {
                                    return stack.formatArn({
                                        service: 'iot',
                                        resource: 'topic',
                                        arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
                                        resourceName: `$aws/rules/${postfix}`
                                    })
                                })
                            ]
                        }),
                        new PolicyStatement({
                            effect: Effect.ALLOW,
                            actions: [
                                'dynamodb:PutItem'
                            ],
                            resources: [
                                this.table.tableArn
                            ]
                        })
                    ]
                })
            }
        });

        const awsIotSqlVersion = props.ruleSqlVersion || '2016-03-23';
        const tableName = "DeviceHealth";
        const LATEST_PK = `"${tableName}:" + accountid() + ":latest" as PK`;
        const LATEST_SK = 'thing_name as SK';
        const createTime = "timestamp as createTime";
        const updateTime = "timestamp as updateTime";
        const errorAction = {
            republish: {
                topic: `${inputTopic}/error`,
                roleArn: this.rulesRole.roleArn
            }
        }
        new CfnTopicRule(this, 'RuleFanOut', {
            ruleName: this.republishRuleName,
            topicRulePayload: {
                sql: `SELECT *, ${createTime}, ${updateTime} FROM '${inputTopic}' WHERE name = "health_end"`,
                ruleDisabled: false,
                awsIotSqlVersion,
                actions: republishTopics.map(postfix => {
                    return {
                        // Republish to index this health audit trail
                        republish: {
                            topic: `$$aws/rules/${postfix}`,
                            qos: 1,
                            roleArn: this.rulesRole.roleArn
                        }
                    };
                }),
                errorAction
            }
        });

        new CfnTopicRule(this, 'RuleLatest', {
            ruleName: this.updateLatestRuleName,
            topicRulePayload: {
                sql: `SELECT *, ${LATEST_PK}, ${LATEST_SK}`,
                ruleDisabled: false,
                awsIotSqlVersion,
                actions: [
                    {
                        dynamoDBv2: {
                            putItem: {
                                tableName: this.table.tableName
                            },
                            roleArn: this.rulesRole.roleArn
                        }

                    }
                ],
                errorAction
            }
        });

        const INDEX_PK = `"${tableName}:" + accountid() + ":" + thing_name as PK`;
        const INDEX_SK = "cast(timestamp as String) as SK";
        const expiresIn = `timestamp + ${(props.expiresDuration || Duration.days(30)).toSeconds()} as expiresIn`;
        new CfnTopicRule(this, 'RuleIndex', {
            ruleName: this.updateIndexRuleName,
            topicRulePayload: {
                sql: `SELECT *, ${INDEX_PK}, ${INDEX_SK}, ${expiresIn}`,
                ruleDisabled: false,
                awsIotSqlVersion,
                actions: [
                    {
                        dynamoDBv2: {
                            putItem: {
                                tableName: this.table.tableName
                            },
                            roleArn: this.rulesRole.roleArn
                        }
                    }
                ],
                errorAction
            }
        });
    }

    addHealthTimeout(id: string, props?: PitsHealthTimeoutProps): void {
        const rate = props?.timeout || Duration.minutes(62);
        const rule = new Rule(this, `${id}EventRule`, {
            enabled: true,
            schedule: Schedule.rate(rate)
        });

        const handler = new Function(this, `${id}Function`, {
            handler: 'index.handler',
            runtime: Runtime.PYTHON_3_9,
            code: Code.fromAsset(path.join(__dirname, 'handlers', 'check_health')),
            memorySize: 512,
            timeout: Duration.minutes(1),
            environment: {
                'TABLE_NAME': this.table.tableName,
                'RATE_IN_SECONDS': rate.toSeconds().toString()
            }
        });

        handler.addToRolePolicy(new PolicyStatement({
            effect: Effect.ALLOW,
            actions: [
                'dynamodb:Query',
                'dynamodb:PutItem'
            ],
            resources: [
                this.table.tableArn
            ]
        }));

        rule.addTarget(new LambdaFunction(handler));
    }
}