import { IFunction } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { IPitsRole, PitsRole } from "./PitsRole";
import { IPitsRoleAlias, PitsRoleAlias } from "./PitsRoleAlias";
import { IPitsStorage, PitsConversionFunctionProps, PitsStorage } from "./PitsStorage";
import { IPitsThingPolicy, PitsThingPolicy } from "./PitsThingPolicy";

export interface PitsDeviceConnectionProps {
    readonly bucketName?: string;
    readonly motionVideoPath?: string;
    readonly motionVideoConvertedPath?: string;
    readonly captureImagePath?: string;
    readonly roleName?: string;
    readonly roleAliasName?: string;
    readonly policyName?: string;
    readonly enableDefaultMotionVideoConversion?: boolean;
    readonly motionVideoConversion?: PitsConversionFunctionProps
}

export class PitsDeviceConnection extends Construct {
    readonly storage: IPitsStorage;
    readonly role: IPitsRole;
    readonly roleAlias: IPitsRoleAlias;
    readonly thingPolicy: IPitsThingPolicy;
    readonly conversionFunction?: IFunction;

    constructor(scope: Construct, id: string, props?: PitsDeviceConnectionProps) {
        super(scope, id);

        this.storage = new PitsStorage(this, 'Storage', {
            bucketName: props?.bucketName,
            motionVideoPath: props?.motionVideoPath,
            motionVideoConvertedPath: props?.motionVideoConvertedPath
        });
        if (props?.motionVideoConversion || props?.enableDefaultMotionVideoConversion === true) {
            this.conversionFunction = this.storage.addConversionFunction(props.motionVideoConversion);
        }
        this.role = new PitsRole(this, 'ThingRole', {
            bucket: this.storage.bucket,
            motionVideoPath: this.storage.motionVideoPath,
            captureImagesPath: props?.captureImagePath
        });
        this.roleAlias = new PitsRoleAlias(this, 'ThingRoleAlias', {
            role: this.role.role,
            roleAliasName: props?.roleAliasName
        });
        this.thingPolicy = new PitsThingPolicy(this, 'ThingPolicy', {
            roleAlias: this.roleAlias,
            policyName: props?.policyName
        });
    }
}