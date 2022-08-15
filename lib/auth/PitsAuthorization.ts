import { Duration } from "aws-cdk-lib";
import { ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import {
    AccountRecovery,
    ClientAttributes,
    Mfa,
    OAuthScope,
    UserPool,
    UserPoolClient,
    UserPoolClientIdentityProvider,
    UserPoolDomain,
    UserPoolEmail
} from "aws-cdk-lib/aws-cognito";
import { ARecord, CnameRecord, IHostedZone, RecordTarget } from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";

export interface PitsAuthorizationCustomDomainProps {
    readonly certificate: ICertificate;
    readonly hostedZone: IHostedZone;
    readonly domainName: string;
    readonly createARecord?: boolean;
}

export interface IPitsAuthorization {
    readonly userPool: UserPool;
    readonly defaultUserClient: UserPoolClient;

    addDomain(id: string, props: PitsAuthorizationCustomDomainProps): UserPoolDomain;
}

export interface PitsAuthorizationProps {
    readonly poolName?: string;
    readonly enableDevelopmentOrigin?: boolean;
    readonly customOrigin?: string;
}

export class PitsAuthorization extends Construct implements IPitsAuthorization {
    readonly userPool: UserPool;
    readonly defaultUserClient: UserPoolClient;

    constructor(scope: Construct, id: string, props?: PitsAuthorizationProps) {
        super(scope, id);

        const userPoolName = props?.poolName || 'pits-user-pool';
        const userPool = new UserPool(this, 'UserPool', {
            userPoolName,
            accountRecovery: AccountRecovery.EMAIL_ONLY,
            selfSignUpEnabled: false,
            email: UserPoolEmail.withCognito('noreply@verificationemail.com'),
            enableSmsRole: false,
            signInCaseSensitive: false,
            mfa: Mfa.OPTIONAL,
            mfaSecondFactor: {
                otp: true,
                sms: false
            },
            passwordPolicy: {
                minLength: 12,
                requireSymbols: true,
                requireDigits: true
            },
            signInAliases: {
                username: true,
                email: true
            }
        });

        const writeAttributes = new ClientAttributes()
            .withStandardAttributes({ fullname: true, email: true });
        const readAttributes = writeAttributes
            .withStandardAttributes({ emailVerified: true });

        let redirectOrigins = [];
        if (props?.enableDevelopmentOrigin === true) {
            redirectOrigins.push('http://localhost:3000');
        }
        if (props?.customOrigin) {
            redirectOrigins.push(props.customOrigin);
        }
        const userPoolClient = userPool.addClient('Client', {
            generateSecret: true,
            authFlows: {
                userSrp: true,
                userPassword: true
            },
            enableTokenRevocation: true,
            accessTokenValidity: Duration.days(1),
            refreshTokenValidity: Duration.days(365),
            idTokenValidity: Duration.days(1),
            readAttributes,
            writeAttributes,
            userPoolClientName: `${userPoolName}-client`,
            supportedIdentityProviders: [
                UserPoolClientIdentityProvider.COGNITO
            ],
            oAuth: {
                flows: {
                    authorizationCodeGrant: true,
                    implicitCodeGrant: true,
                },
                scopes: [
                    OAuthScope.OPENID,
                    OAuthScope.PROFILE,
                    OAuthScope.EMAIL
                ],
                callbackUrls: redirectOrigins.map(origin => `${origin}/login`),
                logoutUrls: redirectOrigins.map(origin => `${origin}/logout`)
            }
        });

        this.userPool = userPool;
        this.defaultUserClient = userPoolClient;
    }

    addDomain(id: string, props: PitsAuthorizationCustomDomainProps): UserPoolDomain {
        let domainId = id;
        if (props.createARecord === true) { 
            const arecord = new ARecord(this, `${id}ARecord`, {
                zone: props.hostedZone,
                target: RecordTarget.fromIpAddresses('198.51.100.1')
            });
            domainId = arecord.node.addr
        }

        const customAuthDomain = this.userPool.addDomain(domainId, {
            customDomain: {
                certificate: props.certificate,
                domainName: props.domainName
            }
        });

        new CnameRecord(this, `${id}AuthAliasRecord`, {
            zone: props.hostedZone,
            domainName: customAuthDomain.cloudFrontDomainName,
            recordName: props.domainName
        });

        return customAuthDomain;
    }
}