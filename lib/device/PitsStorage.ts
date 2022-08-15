import { Aws, Duration } from "aws-cdk-lib";
import { IRepository, Repository, RepositoryEncryption } from "aws-cdk-lib/aws-ecr";
import { DockerImageAsset } from "aws-cdk-lib/aws-ecr-assets";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { EcrImageCode, Function, Handler, IFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { Bucket, EventType, IBucket, LifecycleRule, StorageClass } from "aws-cdk-lib/aws-s3";
import { LambdaDestination } from "aws-cdk-lib/aws-s3-notifications";
import { DockerImageName, ECRDeployment } from "cdk-ecr-deployment";
import { Construct } from "constructs";
import * as path from 'path';

export interface PitsStorageProps {
    readonly bucketName?: string;
    readonly motionVideoPath?: string;
    readonly motionVideoConvertedPath?: string;
    readonly expireMotionVideos?: boolean;
}

export interface PitsConversionFunctionProps {
    readonly framerate?: number;
    readonly conversionFormat?: string;
    readonly functionTimeout?: Duration;
    readonly functionMemorySize?: number;
    readonly containerRepository?: IRepository;
}

export interface IPitsStorage {
    readonly bucket: IBucket;
    readonly motionVideoPath: string;
    readonly motionVideoConvertedPath: string;

    addConversionFunction(props?: PitsConversionFunctionProps): IFunction;
    arnForMotionVideoObjects(): string;
    arnForMotionVideoConvertedObjects(): string;
}

export class PitsStorage extends Construct implements IPitsStorage {
    readonly bucket: IBucket;
    readonly motionVideoPath: string;
    readonly motionVideoConvertedPath: string;

    constructor(scope: Construct, id: string, props?: PitsStorageProps) {
        super(scope, id);

        this.motionVideoPath = props?.motionVideoPath || 'motion_videos';
        this.motionVideoConvertedPath = props?.motionVideoConvertedPath || 'motion_videos_converted';

        let lifecycleRules: Array<LifecycleRule> | undefined = undefined;
        if (props?.expireMotionVideos === undefined || props.expireMotionVideos === true) {
            lifecycleRules = [
                {
                    enabled: true,
                    prefix: `${this.motionVideoPath}/`,
                    expiration: Duration.days(30)
                },
                {
                    enabled: true,
                    prefix: `${this.motionVideoConvertedPath}/`,
                    transitions: [
                        {
                            transitionAfter: Duration.days(30),
                            storageClass: StorageClass.INFREQUENT_ACCESS
                        },
                        {
                            transitionAfter: Duration.days(90),
                            storageClass: StorageClass.GLACIER
                        },
                        {
                            transitionAfter: Duration.days(180),
                            storageClass: StorageClass.DEEP_ARCHIVE
                        }
                    ]
                }
            ];
        }

        this.bucket = new Bucket(this, 'Bucket', {
            bucketName: props?.bucketName,
            lifecycleRules
        });
    }

    addConversionFunction(props?: PitsConversionFunctionProps): IFunction {
        const conversionImage = new DockerImageAsset(this, 'ConvertImage', {
            directory: path.join(__dirname, 'image')
        });
        const ecrRepo = props?.containerRepository || new Repository(this, 'ConvertECR', {
            encryption: RepositoryEncryption.AES_256,
            repositoryName: 'pits-convert'
        });
        const conversionEcrDeployment = new ECRDeployment(this, 'ConvertECRDeployment', {
            src: new DockerImageName(conversionImage.imageUri),
            dest: new DockerImageName(`${Aws.ACCOUNT_ID}.dkr.ecr.${Aws.REGION}.amazonaws.com/${ecrRepo.repositoryName}:latest`)
        });

        let conversionPath = this.motionVideoConvertedPath;
        let lastSlashIndex = conversionPath.lastIndexOf('/');
        if (lastSlashIndex === conversionPath.length - 1) {
            conversionPath = conversionPath.substring(0, lastSlashIndex);
        }
        const conversionFunction = new Function(this, 'ConvertFunction', {
            handler: Handler.FROM_IMAGE,
            runtime: Runtime.FROM_IMAGE,
            code: new EcrImageCode(ecrRepo),
            environment: {
                'CONVERSION_FORMAT': (props?.conversionFormat || 'mp4'),
                'CONVERSION_PATH': conversionPath,
                'FRAMERATE': (props?.framerate || 15).toString(),
            },
            memorySize: props?.functionMemorySize || 1024,
            timeout: props?.functionTimeout || Duration.minutes(2)
        });
        conversionFunction.addToRolePolicy(new PolicyStatement({
            effect: Effect.ALLOW,
            actions: [
                's3:GetObject'
            ],
            resources: [
                this.bucket.arnForObjects(`${this.motionVideoPath}/*`)
            ]
        }));
        conversionFunction.addToRolePolicy(new PolicyStatement({
            effect: Effect.ALLOW,
            actions: [
                's3:PutObject'
            ],
            resources: [
                this.bucket.arnForObjects(`${this.motionVideoConvertedPath}/*`)
            ]
        }));
        conversionFunction.node.addDependency(conversionEcrDeployment);
        this.bucket.addEventNotification(EventType.OBJECT_CREATED, new LambdaDestination(conversionFunction), {
            prefix: `${this.motionVideoPath}/*`
        });
        return conversionFunction;
    }

    arnForMotionVideoObjects(): string {
        return this.bucket.arnForObjects(`${this.motionVideoPath}/*`);
    }

    arnForMotionVideoConvertedObjects(): string {
        return this.bucket.arnForObjects(`${this.motionVideoConvertedPath}/*`);
    }
}