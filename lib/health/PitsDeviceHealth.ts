import { ArnFormat, Duration, Stack } from "aws-cdk-lib";
import { ITable } from "aws-cdk-lib/aws-dynamodb";
import { Effect, IRole, PolicyDocument, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnTopicRule } from "aws-cdk-lib/aws-iot";
import { Construct } from "constructs";

export interface PitsDeviceHealthProps {
    readonly inputTopic?: string;
    readonly table: ITable;
    readonly expiresDuration?: Duration;
}

export interface IPitsDeviceHealth {
    readonly rulesRole: IRole;
    readonly updateLatestRuleName: string;
    readonly updateIndexRuleName: string;
}

export class PitsDeviceHealth extends Construct implements IPitsDeviceHealth {
    readonly rulesRole: IRole;
    readonly updateLatestRuleName: string;
    readonly updateIndexRuleName: string;

    constructor(scope: Construct, id: string, props: PitsDeviceHealthProps) {
        super(scope, id);

        const inputTopic = props.inputTopic || 'pinthesky/events/output';
        const republishTopic = `${inputTopic}/index`;
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
                                    resourceName: republishTopic
                                })
                            ]
                        }),
                        new PolicyStatement({
                            effect: Effect.ALLOW,
                            actions: [
                                'dynamodb:PutItem'
                            ],
                            resources: [
                                props.table.tableArn
                            ]
                        })
                    ]
                })
            }
        });

        const tableName = "DeviceHealth";
        const LATEST_PK = `accountid() + ":${tableName}:latest" as PK`;
        const LATEST_SK = 'clientid() as SK';
        const createTime = "timestamp as createTime";
        const updateTime = "timestamp as updateTime";
        this.updateLatestRuleName = `${id}RuleLatest`;
        new CfnTopicRule(this, 'RuleLatest', {
            ruleName: this.updateLatestRuleName,
            topicRulePayload: {
                sql: `SELECT *, ${LATEST_PK}, ${LATEST_SK}, ${createTime}, ${updateTime} FROM '${inputTopic}' WHERE name = "health_end"`,
                ruleDisabled: false,
                actions: [
                    {
                        // Republish to index this health audit trail
                        republish: {
                            topic: republishTopic,
                            qos: 1,
                            roleArn: this.rulesRole.roleArn
                        },
                        dynamoDBv2: {
                            putItem: {
                                tableName: props.table.tableName
                            },
                            roleArn: this.rulesRole.roleArn
                        }
                    }
                ]
            }
        });

        const INDEX_PK = `accountid() + ":${tableName}:" + thing_name as PK`;
        const INDEX_SK = "timestamp as SK";
        const expiresIn = `timestamp + ${props.expiresDuration || Duration.days(30).toSeconds()} as expiresIn`;
        this.updateIndexRuleName = `${id}RuleIndex`;
        new CfnTopicRule(this, 'RuleIndex', {
            ruleName: this.updateIndexRuleName,
            topicRulePayload: {
                sql: `SELECT *, ${INDEX_PK}, ${INDEX_SK}, ${createTime}, ${updateTime}, ${expiresIn} FROM '${republishTopic}' WHERE name = "health_end"`,
                ruleDisabled: false,
                actions: [
                    {
                        dynamoDBv2: {
                            putItem: {
                                tableName: props.table.tableName
                            },
                            roleArn: this.rulesRole.roleArn
                        }
                    }
                ]
            }
        });
    }
}