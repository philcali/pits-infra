import { ArnFormat, Stack } from "aws-cdk-lib";
import { Effect, IRole, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { AwsCustomResource, PhysicalResourceId } from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

export interface PitsRoleAliasProps {
    readonly roleAliasName ?: string;
    readonly role: IRole;
}

export interface IPitsRoleAlias {
    readonly roleAliasArn: string;
    readonly roleAliasName: string;
}

export class PitsRoleAlias extends Construct implements IPitsRoleAlias {
    readonly roleAliasArn: string;
    readonly roleAliasName: string;    

    constructor(scope: Construct, id: string, props: PitsRoleAliasProps) {
        super(scope, id);

        let stack = Stack.of(scope);
        this.roleAliasName = props.roleAliasName || 'PinTheSkyRoleAlias';
        const roleAlias = new AwsCustomResource(this, 'RoleAlias', {
            policy: {
                statements: [
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: [
                        'iot:CreateRoleAlias',
                        'iot:DeleteRoleAlias'
                    ],
                    resources: [
                        stack.formatArn({
                            service: 'iot',
                            resource: `rolealias/${this.roleAliasName}`
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
                        props.role.roleArn
                    ]
                })
                ]
            },
            onCreate: {
                physicalResourceId: PhysicalResourceId.of(this.roleAliasName),
                service: 'Iot',
                action: 'createRoleAlias',
                parameters: {
                    roleAlias: this.roleAliasName,
                    roleArn: props.role.roleArn
                }
            },
            onDelete: {
                physicalResourceId: PhysicalResourceId.of(this.roleAliasName),
                service: 'Iot',
                action: 'deleteRoleAlias',
                parameters: {
                    roleAlias: this.roleAliasName
                }
            }
        });

        this.roleAliasArn = stack.formatArn({
            service: 'iot',
            resource: 'rolealias',
            arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
            resourceName: this.roleAliasName
        });
    }
}