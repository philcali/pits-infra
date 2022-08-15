import { ArnFormat, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { HostedZone } from 'aws-cdk-lib/aws-route53';
import { PitsDeviceConnection } from './device/PitsDeviceConnection';
import { PitsAuthorization } from './auth/PitsAuthorization';
import { PitsResourceService } from './api/PitsResourceService';

const ZONE_ID = 'Z2DL6AR506I4EE';
const CERTIFICATE_ID = 'f2674298-1642-4284-a9a6-e90b8803ff6e';

export class PitsInfraStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const certificate = Certificate.fromCertificateArn(this, 'PitsShortenerCertificate', this.formatArn({
      service: 'acm',
      resource: 'certificate',
      resourceName: CERTIFICATE_ID,
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME
    }));

    const hostedZone = HostedZone.fromHostedZoneAttributes(this, 'PitsHostedZone', {
      hostedZoneId: ZONE_ID,
      zoneName: 'pinthesky.com'
    });

    const deviceConnection = new PitsDeviceConnection(this, 'DeviceConnection', {
      bucketName: 'philcali-pinthesky-storage',
      enableDefaultMotionVideoConversion: true
    });

    const authorization = new PitsAuthorization(this, 'Authorization', {
      enableDevelopmentOrigin: true,
      customOrigin: "https://api.pinthesky.com"
    });

    authorization.addDomain('CustomDomain', {
      certificate,
      hostedZone,
      domainName: 'auth.pinthesky.com',
      createARecord: true
    });

    const resourceService = new PitsResourceService(this, 'ResourceService', {
      enableDevelopmentOrigin: true,
      storage: deviceConnection.storage,
      captureImagePath: deviceConnection.role.captureImagesPath,
      consoleOrigin: "https://pinthesky.com",
      authorization: {
        issuer: authorization.userPool.userPoolProviderUrl,
        audience: [
          authorization.defaultUserClient.userPoolClientId
        ]
      }
    });

    resourceService.addDomain('CustonDomain', {
      certificate,
      hostedZone,
      domainName: 'api.pinthesky.com'
    })
  }
}
