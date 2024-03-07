import { ArnFormat, Resource, Stack } from "aws-cdk-lib";
import { ILogGroup, LogGroup, LogGroupClass, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { IPitsRole } from "./PitsRole";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";

export interface IPitsLogging {
    readonly logGroup: ILogGroup;

    allowDeviceManagement(pitsRole: IPitsRole): void;
}

export interface PitsLoggingProps {
    readonly logGroupName?: string;
    readonly logGroupClass?: LogGroupClass;
    readonly retention?: RetentionDays;
    readonly allowedRoles?: IPitsRole[];
}

export class PitsLogging extends Resource implements IPitsLogging {
    readonly logGroup: ILogGroup;
    

    constructor(scope: Construct, id: string, props?: PitsLoggingProps) {
        super(scope, id);

        this.logGroup = new LogGroup(this, 'LogGroup', {
            logGroupName: props?.logGroupName,
            logGroupClass: props?.logGroupClass || LogGroupClass.STANDARD,
            retention: props?.retention || RetentionDays.TWO_YEARS,
        });

        props?.allowedRoles?.forEach(role => this.allowDeviceManagement(role));
    }

    allowDeviceManagement(pitsRole: IPitsRole) {
        pitsRole.managedPolicy.addStatements(
            new PolicyStatement({
                effect: Effect.ALLOW,
                actions: [
                    'logs:CreateLogStream',
                    'logs:DescribeLogStreams',
                    'logs:PutLogEvents',
                ],
                resources: [
                    `${this.logGroup.logGroupArn}:log-stream:*`,
                ]
            }),
            new PolicyStatement({
                effect: Effect.ALLOW,
                actions: [
                    'logs:DescribeLogGroups',
                ],
                resources: [
                    Stack.of(this).formatArn({
                        service: 'logs',
                        resource: 'log-group',
                        resourceName: '*',
                        arnFormat: ArnFormat.COLON_RESOURCE_NAME
                    })
                ]
            })
        );
    }
}