import {
    Effect,
    IRole,
    ManagedPolicy,
    PolicyDocument,
    PolicyStatement,
    Role,
    ServicePrincipal
} from "aws-cdk-lib/aws-iam";
import { IBucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export interface PitsRoleProps {
    readonly roleName?: string;
    readonly managedPolicyName?: string;
    readonly motionVideoPath?: string;
    readonly captureImagesPath?: string;
    readonly bucket: IBucket;
}

export interface IPitsRole {
    readonly role: IRole;
    readonly managedPolicy: ManagedPolicy;
    readonly motionVideoPath: string;
    readonly captureImagesPath: string;
}

export class PitsRole extends Construct implements IPitsRole {
    readonly role: IRole;
    readonly managedPolicy: ManagedPolicy;
    readonly motionVideoPath: string;
    readonly captureImagesPath: string;

    constructor(scope: Construct, id: string, props: PitsRoleProps) {
        super(scope, id);

        const pitsRole = new Role(this, 'Role', {
            roleName: props.roleName || 'PinTheSkyRole',
            assumedBy: new ServicePrincipal('credentials.iot.amazonaws.com')
        });

        this.role = pitsRole;
        this.motionVideoPath = props.motionVideoPath || 'motion_videos';
        this.captureImagesPath = props.captureImagesPath || 'capture_images';
        this.managedPolicy = new ManagedPolicy(this, 'UploadPolicy', {
            managedPolicyName: props.managedPolicyName || `${props.bucket.bucketName}-policy`,
            document: new PolicyDocument({
                statements: [
                    new PolicyStatement({
                        effect: Effect.ALLOW,
                        actions: [
                            's3:PutObject*',
                            's3:Abort*'
                        ],
                        resources: [
                            props.bucket.arnForObjects(`${this.motionVideoPath}/*`),
                            props.bucket.arnForObjects(`${this.captureImagesPath}/*`)
                        ]
                    }),
                ]
            }),
            roles: [ pitsRole ]
        });
    }
}