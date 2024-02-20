import { Stack } from "aws-cdk-lib";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { AwsCustomResource, PhysicalResourceId } from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import { IPitsRoleAlias } from "./PitsRoleAlias";

export interface PitsThingPolicyProps {
    readonly policyName ?: string;
    readonly roleAlias: IPitsRoleAlias;
} 

export interface IPitsThingPolicy {
    readonly policyName: string;
}

export class PitsThingPolicy extends Construct implements IPitsThingPolicy {
    readonly policyName: string;

    constructor(scope: Construct, id: string, props: PitsThingPolicyProps) {
        super(scope, id);

        let stack = Stack.of(scope);
        this.policyName = props.policyName || 'PinTheSkyThingPolicy';
        const policyDocument = {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Effect": "Allow",
                    "Action": [
                        "iot:Connect"
                    ],
                    "Resource": [
                        stack.formatArn({
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
                        stack.formatArn({
                            service: 'iot',
                            resource: 'topic/pinthesky/events/output'
                        }),
                        // Runtime configuration updates
                        stack.formatArn({
                            service: 'iot',
                            resource: 'topic/$aws/things/${iot:Connection.Thing.ThingName}/shadow/name/pinthesky/*'
                        }),
                        // Jobs software updates
                        stack.formatArn({
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
                        stack.formatArn({
                            service: 'iot',
                            resource: 'topicfilter/pinthesky/events/${iot:Connection.Thing.ThingName}/input'
                        }),
                        // Configuration changes
                        stack.formatArn({
                            service: 'iot',
                            resource: 'topicfilter/$aws/things/${iot:Connection.Thing.ThingName}/shadow/name/pinthesky/*'
                        }),
                        // Software updates
                        stack.formatArn({
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
                        stack.formatArn({
                            service: 'iot',
                            resource: 'topic/pinthesky/events/${iot:Connection.Thing.ThingName}/input'
                        }),
                        // Configuration changes
                        stack.formatArn({
                            service: 'iot',
                            resource: 'topic/$aws/things/${iot:Connection.Thing.ThingName}/shadow/name/pinthesky/*'
                        }),
                        // Software updates
                        stack.formatArn({
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
                        props.roleAlias.roleAliasArn
                    ]
                }
            ] 
        };

        new AwsCustomResource(this, 'ThingPolicy', {
            installLatestAwsSdk: true,
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
                        stack.formatArn({
                            service: 'iot',
                            resource: `policy/${this.policyName}`
                        })
                    ]
                })
                ]
            },
            onCreate: {
                physicalResourceId: PhysicalResourceId.of(this.policyName),
                service: 'Iot',
                action: 'createPolicy',
                parameters: {
                    policyName: this.policyName,
                    policyDocument: JSON.stringify(policyDocument)
                }
            },
            onUpdate: {
                physicalResourceId: PhysicalResourceId.of(this.policyName),
                service: 'Iot',
                action: 'createPolicyVersion',
                parameters: {
                    policyName: this.policyName,
                    policyDocument: JSON.stringify(policyDocument),
                    setAsDefault: true
                }
            },
            onDelete: {
                physicalResourceId: PhysicalResourceId.of(this.policyName),
                service: 'Iot',
                action: 'deletePolicy',
                parameters: {
                    policyName: this.policyName
                }
            }
        });
    }
}