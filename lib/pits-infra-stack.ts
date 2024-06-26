import { ArnFormat, Duration, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Certificate, ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { HostedZone, IHostedZone } from 'aws-cdk-lib/aws-route53';
import { IPitsDeviceConnection, PitsDeviceConnection } from './device/PitsDeviceConnection';
import { PitsAuthorization } from './auth/PitsAuthorization';
import { IPitsResourceService, PitsResourceService } from './api/PitsResourceService';
import { SubmoduleCode } from './SubmoduleCode';
import { PitsConsole } from './console/PitsConsole';
import { Source } from 'aws-cdk-lib/aws-s3-deployment';
import { IPitsDeviceHealth, PitsDeviceHealth } from './health/PitsDeviceHealth';
import { IPitsAuthorization } from './auth/PitsAuthorization';
import { PitsStorage } from './device/PitsStorage';
import { 
  ZONE_NAME,
  ZONE_ID,
  CERTIFICATE_ID,
  CONSOLE_BUCKET_NAME,
  DEVICE_BUCKET_NAME
} from './constants';
import { IPitsLogging, PitsLogging } from './device/PitsLogging';
import { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { IPitsDataService, PitsDataService } from './data/PitsDataService';
import { AwsIotAccountEndpoint, IAwsIotAccountEndpoint } from './api/AwsIotAccountEndpoint';
import * as path from 'path';
import { IManagedPolicy, IRole, ManagedPolicy, Role } from 'aws-cdk-lib/aws-iam';
import { PitsRole } from './device/PitsRole';

export interface PitsDeviceConnectionStackProps extends StackProps {
  readonly bucketName: string;
}

export class PitsDeviceConnectionStack extends Stack {
  readonly deviceConnection: IPitsDeviceConnection;
  readonly deviceLogging: IPitsLogging;

  constructor(scope: Construct, id: string, props: PitsDeviceConnectionStackProps) {
    super(scope, id, {
      stackName: 'PitsDeviceConnection',
      ...props
    });

    this.deviceConnection = new PitsDeviceConnection(this, 'DeviceConnection', {
      bucketName: props.bucketName,
      enableDefaultMotionVideoConversion: true,
    });

    this.deviceLogging = new PitsLogging(this, 'DeviceLogging', {
      logGroupName: '/pits/device/DaemonLogging',
      allowedRoles: [ this.deviceConnection.role ]
    })
  }
}

export interface PitsReachabilityProps {
  readonly consoleDomain?: string;
  readonly apiDomain?: string;
  readonly certificate?: ICertificate;
  readonly hostedZone?: IHostedZone;
}

export type PitsAuthorizationStackProps = StackProps & PitsReachabilityProps;

export class PitsAuthorizationStack extends Stack {
  readonly authorization: IPitsAuthorization;
  constructor(scope: Construct, id: string, props: PitsAuthorizationStackProps) {
    super(scope, id, {
      stackName: 'PitsAuthorization',
      ...props
    });

    let customOrigins = [props.apiDomain, props.consoleDomain]
      .filter(domain => domain !== undefined)
      .map(domain => `https://${domain}`);
    
    const authorization = new PitsAuthorization(this, 'Authorization', {
      enableDevelopmentOrigin: true,
      customOrigins,
    });
    this.authorization = authorization;

    if (props.certificate && props.hostedZone) {
      authorization.addDomain('CustomDomain', {
        certificate: props.certificate,
        hostedZone: props.hostedZone,
        domainName: `auth.${ZONE_NAME}`,
        createARecord: true
      });
    }
  }
}

export interface PitsApiStackProps extends StackProps, PitsReachabilityProps {
  readonly authorization: IPitsAuthorization;
  readonly captureImagesPath: string;
  readonly bucketName: string;
  readonly motionVideosPath: string;
  readonly motionVideosCapturedPath: string;
  readonly dataEndpoint?: IAwsIotAccountEndpoint;
}

export class PitsApiStack extends Stack {
  readonly resourceService: IPitsResourceService;
  readonly health: IPitsDeviceHealth;

  constructor(scope: Construct, id: string, props: PitsApiStackProps) {
    super(scope, id, {
      stackName: 'PitsApi',
      ...props
    });

    const resourceService = new PitsResourceService(this, 'ResourceService', {
      dataEndpoint: props.dataEndpoint,
      enableDevelopmentOrigin: true,
      storage: PitsStorage.fromImportProps(this, 'ImportedPitsStorage', {
        bucketName: props.bucketName,
        motionVideoPath: props.motionVideosPath,
        motionVideoConvertedPath: props.motionVideosCapturedPath,
        captureImagePath: props.captureImagesPath,
      }),
      captureImagePath: props.captureImagesPath,
      consoleOrigin: `https://${props.consoleDomain}`,
      functionCode: new SubmoduleCode(path.join(__dirname, 'assets', 'api'), {
          moduleName: 'lib/assets/api',
          buildCommand: './dev.make-zip.sh',
          buildOutput: 'build_function.zip'
      }),
      authorization: {
        issuer: props.authorization.userPool.userPoolProviderUrl,
        audience: [
          props.authorization.defaultUserClient.userPoolClientId
        ]
      }
    });
    this.resourceService = resourceService;

    if (props.certificate && props.hostedZone && props.apiDomain) {
      resourceService.addDomain('CustonDomain', {
        certificate: props.certificate,
        hostedZone: props.hostedZone,
        domainName: props.apiDomain
      });
    }
  
    if (props.consoleDomain) {
      resourceService.addNotification('Motion', {
        baseUrl: `https://${props.consoleDomain}`
      });
    }

    this.resourceService.addSoftwareVersionNotification('DeviceSoftware');

    const health = new PitsDeviceHealth(this, 'CameraHealth', {
      table: resourceService.table,
      expiresDuration: Duration.days(30),
    });
    this.health = health;

    health.addHealthTimeout('Check');
  }
}

export interface PitsConsoleStackProps extends StackProps, PitsReachabilityProps {
  readonly bucketName: string;
}

export class PitsConsoleStack extends Stack {
  readonly console: PitsConsole;

  constructor(scope: Construct, id: string, props: PitsConsoleStackProps) {
    super(scope, id, {
      stackName: 'PitsConsole',
      ...props
    });

    let domainNames: undefined | string[]
    if (props.consoleDomain) {
      domainNames = [props.consoleDomain];
    }
    this.console = new PitsConsole(this, 'Console', {
      sources: [
        Source.asset(path.join(__dirname, 'assets', 'console', 'build'))
      ],
      bucketName: props.bucketName,
      certificate: props.certificate,
      hostedZone: props.hostedZone,
      domainNames,
    });
  }
}

export interface PitsDataStackProps extends StackProps, PitsReachabilityProps {
  readonly table: ITable;
  readonly authorization: IPitsAuthorization;
  readonly pitsRoleNames: string[];
  readonly dataDomain?: string;
  readonly dataEndpoint?: IAwsIotAccountEndpoint;
}

export class PitsDataStack extends Stack {
  readonly dataService: IPitsDataService;

  constructor(scope: Construct, id: string, props: PitsDataStackProps) {
    super(scope, id, {
      stackName: 'PitsData',
      ...props,
    });

    this.dataService = new PitsDataService(this, 'DataPlaneApi', {
      table: props.table,
      dataEndpoint: props.dataEndpoint,
      dataDomain: props.dataDomain,
      allowedManagementRoles: props.pitsRoleNames,
      authorization: {
        userPoolId: props.authorization.userPool.userPoolId,
        clientId: props.authorization.defaultUserClient.userPoolClientId,
      },
      functionCode: new SubmoduleCode(path.join(__dirname, 'assets', 'data'), {
          moduleName: 'lib/assets/data',
          buildCommand: './dev.make-zip.sh',
          buildOutput: 'build_function.zip'
      }),
    });

    if (props.dataDomain && props.certificate && props.hostedZone) {
      this.dataService.addDomain('CustomDomain', {
        certificate: props.certificate,
        hostedZone: props.hostedZone,
        domainName: props.dataDomain,
      })
    }
  }
}

export class PitsInfraStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    let certificate: undefined | ICertificate;
    let hostedZone: undefined | IHostedZone;
    let apiDomain: undefined | string;
    let consoleDomain: undefined | string;
    let dataDomain: undefined | string;
    const dataEndpoint = AwsIotAccountEndpoint.dataEndpoint(this);

    if (CERTIFICATE_ID) {
      certificate = Certificate.fromCertificateArn(this, 'PitsShortenerCertificate', this.formatArn({
        service: 'acm',
        resource: 'certificate',
        resourceName: CERTIFICATE_ID,
        arnFormat: ArnFormat.SLASH_RESOURCE_NAME
      }));
    }

    if (ZONE_ID && ZONE_NAME) {
      hostedZone = HostedZone.fromHostedZoneAttributes(this, 'PitsHostedZone', {
        hostedZoneId: ZONE_ID,
        zoneName: ZONE_NAME
      });
      apiDomain = `api.${ZONE_NAME}`;
      consoleDomain = `app.${ZONE_NAME}`;
      dataDomain = `data.${ZONE_NAME}`;
    }

    const deviceConnectionStack = new PitsDeviceConnectionStack(this, 'DeviceConnectionStack', {
      bucketName: DEVICE_BUCKET_NAME,
    });

    const authorizationStack = new PitsAuthorizationStack(this, 'AuthorizationStack', {
      apiDomain,
      certificate,
      hostedZone,
      consoleDomain
    });

    const apiStack = new PitsApiStack(this, 'ApiStack', {
      apiDomain,
      consoleDomain,
      certificate,
      hostedZone,
      dataEndpoint,
      authorization: authorizationStack.authorization,
      bucketName: deviceConnectionStack.deviceConnection.storage.bucket.bucketName,
      motionVideosPath: deviceConnectionStack.deviceConnection.storage.motionVideoPath,
      motionVideosCapturedPath: deviceConnectionStack.deviceConnection.storage.motionVideoConvertedPath,
      captureImagesPath: deviceConnectionStack.deviceConnection.storage.captureImagePath,
    });

    new PitsDataStack(this, 'DataStack', {
      table: apiStack.resourceService.table,
      authorization: authorizationStack.authorization,
      pitsRoleNames: [
        deviceConnectionStack.deviceConnection.role.role.roleName,
        apiStack.resourceService.lambdaFunction.role?.roleName as string,
      ],
      dataDomain,
      dataEndpoint,
      certificate,
      hostedZone,
    });

    new PitsConsoleStack(this, 'ConsoleStack', {
      apiDomain,
      consoleDomain,
      certificate,
      hostedZone,
      bucketName: CONSOLE_BUCKET_NAME,
    });
  }
}
