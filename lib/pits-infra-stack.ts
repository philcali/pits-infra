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
import * as path from 'path';
import { IPitsLogging, PitsLogging } from './device/PitsLogging';

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

export class PitsInfraStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    let certificate: undefined | ICertificate;
    let hostedZone: undefined | IHostedZone;
    let apiDomain: undefined | string;
    let consoleDomain: undefined | string;

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

    new PitsApiStack(this, 'ApiStack', {
      apiDomain,
      consoleDomain,
      certificate,
      hostedZone,
      authorization: authorizationStack.authorization,
      bucketName: deviceConnectionStack.deviceConnection.storage.bucket.bucketName,
      motionVideosPath: deviceConnectionStack.deviceConnection.storage.motionVideoPath,
      motionVideosCapturedPath: deviceConnectionStack.deviceConnection.storage.motionVideoConvertedPath,
      captureImagesPath: deviceConnectionStack.deviceConnection.storage.captureImagePath,
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
