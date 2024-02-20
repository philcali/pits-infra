import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { AwsCustomResource, PhysicalResourceId } from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

export interface IAwsIotAccountEndpoint {
    readonly endpointAddress: string;
    readonly endpointType: string;
}

export interface AwsIotAccountEndpointProps {
    readonly endpointType?: string;
}

export class AwsIotAccountEndpoint extends Construct implements IAwsIotAccountEndpoint {
    readonly endpointAddress: string;
    readonly endpointType: string;

    constructor(scope: Construct, id: string, props?: AwsIotAccountEndpointProps) {
        super(scope, id);

        this.endpointType = props?.endpointType || 'iot:data-ats';
        const sdkPartial = {
            service: 'Iot',
            action: 'describeEndpoint',
            parameters: {
                endpointType: this.endpointType
            }
        };
        const endpoint = new AwsCustomResource(this, 'Address', {
            installLatestAwsSdk: true,
            policy: {
                statements: [
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: [
                        'iot:DescribeEndpoint'
                    ],
                    resources: [
                        '*'
                    ]
                })
                ]
            },
            onCreate: {
                ...sdkPartial,
                physicalResourceId: PhysicalResourceId.of('iot' + id),
            },
            onUpdate: {
                ...sdkPartial,
            }
        });

        this.endpointAddress = endpoint.getResponseField('endpointAddress');
    }

    static dataEndpoint(scope: Construct) {
        return new AwsIotAccountEndpoint(scope, 'DataEndpoint', {
            endpointType: 'iot:data-ats'
        });
    }

    static credentialsEndpoint(scope: Construct) {
        return new AwsIotAccountEndpoint(scope, 'CredentialEndpoint', {
            endpointType: 'iot:credentialProvider'
        });
    }
}