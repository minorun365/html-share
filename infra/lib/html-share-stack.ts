import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface HtmlShareStackProps extends StackProps {
  ownerEmail: string;
  consoleDomain: string;
  contentDomain: string;
  certificateArn: string;
  cognitoDomainPrefix: string;
  privateKeyParameterName: string;
  publicKeyPem: string;
  maximumShareDays: number;
  allowedInternalCidrs: string[];
}

function securityPolicy(
  scope: Construct,
  id: string,
  content: boolean,
  consoleOrigin: string,
  contentOrigin: string,
): cloudfront.ResponseHeadersPolicy {
  const csp = content
    ? `default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data:; font-src data:; media-src data:; frame-src 'none'; connect-src 'none'; form-action 'none'; frame-ancestors ${consoleOrigin}; base-uri 'none'; sandbox allow-scripts`
    : `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src ${contentOrigin}; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`;
  return new cloudfront.ResponseHeadersPolicy(scope, id, {
    securityHeadersBehavior: {
      contentSecurityPolicy: { contentSecurityPolicy: csp, override: true },
      contentTypeOptions: { override: true },
      ...(content ? {} : {
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
      }),
      referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
      strictTransportSecurity: {
        accessControlMaxAge: Duration.days(365),
        includeSubdomains: true,
        preload: true,
        override: true,
      },
    },
    customHeadersBehavior: {
      customHeaders: [
        { header: 'Cache-Control', value: 'no-store, max-age=0', override: true },
        { header: 'X-Robots-Tag', value: 'noindex, nofollow, nosnippet, noimageindex, noarchive', override: true },
        { header: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()', override: true },
      ],
    },
  });
}

export class HtmlShareStack extends Stack {
  constructor(scope: Construct, id: string, props: HtmlShareStackProps) {
    super(scope, id, props);

    const certificate = acm.Certificate.fromCertificateArn(this, 'Certificate', props.certificateArn);
    const consoleOrigin = `https://${props.consoleDomain}`;
    const contentOrigin = `https://${props.contentDomain}`;
    const callbackUrl = `${consoleOrigin}/auth/callback`;
    const cognitoOrigin = `https://${props.cognitoDomainPrefix}.auth.${this.region}.amazoncognito.com`;

    const consoleBucket = new s3.Bucket(this, 'ConsoleBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const contentBucket = new s3.Bucket(this, 'ContentBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const publicKey = new cloudfront.PublicKey(this, 'SigningPublicKey', {
      encodedKey: props.publicKeyPem,
      comment: 'HTML Share signed URL verification key',
    });
    const keyGroup = new cloudfront.KeyGroup(this, 'SigningKeyGroup', {
      items: [publicKey],
      comment: 'HTML Share trusted signers',
    });

    const contentDistribution = new cloudfront.Distribution(this, 'ContentDistribution', {
      domainNames: [props.contentDomain],
      certificate,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(contentBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        responseHeadersPolicy: securityPolicy(this, 'ContentHeaders', true, consoleOrigin, contentOrigin),
        trustedKeyGroups: [keyGroup],
        compress: true,
      },
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
    });

    const reviewTable = new dynamodb.Table(this, 'ReviewTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: 'expiresAt',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const userPool = new cognito.UserPool(this, 'OwnerUserPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: false } },
      accountRecovery: cognito.AccountRecovery.NONE,
      mfa: cognito.Mfa.OFF,
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      signInPolicy: { allowedFirstAuthFactors: { password: true, emailOtp: true } },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    new cognito.CfnUserPoolUser(this, 'OwnerUser', {
      userPoolId: userPool.userPoolId,
      username: props.ownerEmail,
      messageAction: 'SUPPRESS',
      userAttributes: [
        { name: 'email', value: props.ownerEmail },
        { name: 'email_verified', value: 'true' },
      ],
    });
    const userPoolClient = userPool.addClient('OwnerClient', {
      generateSecret: false,
      authFlows: { user: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        callbackUrls: [callbackUrl],
        logoutUrls: [consoleOrigin],
        defaultRedirectUri: callbackUrl,
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      authSessionValidity: Duration.minutes(10),
      accessTokenValidity: Duration.minutes(10),
      idTokenValidity: Duration.minutes(10),
      refreshTokenValidity: Duration.days(1),
    });
    new cognito.CfnManagedLoginBranding(this, 'OwnerBranding', {
      userPoolId: userPool.userPoolId,
      clientId: userPoolClient.userPoolClientId,
      useCognitoProvidedValues: true,
    });
    userPool.addDomain('OwnerDomain', {
      cognitoDomain: { domainPrefix: props.cognitoDomainPrefix },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    const privateKeyParameter = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      'PrivateKeyParameter',
      { parameterName: props.privateKeyParameterName },
    );
    const authLogGroup = new logs.LogGroup(this, 'AuthLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const authFunction = new lambdaNodejs.NodejsFunction(this, 'AuthFunction', {
      entry: path.join(HERE, '..', '..', 'functions', 'auth-handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(15),
      logGroup: authLogGroup,
      tracing: lambda.Tracing.ACTIVE,
      bundling: { minify: true, sourceMap: false, target: 'node22' },
      environment: {
        CALLBACK_URL: callbackUrl,
        CLOUDFRONT_KEY_PAIR_ID: publicKey.publicKeyId,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
        COGNITO_ORIGIN: cognitoOrigin,
        CONSOLE_ORIGIN: consoleOrigin,
        OWNER_EMAIL: props.ownerEmail,
        PRIVATE_KEY_PARAMETER_NAME: props.privateKeyParameterName,
      },
    });
    authFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [privateKeyParameter.parameterArn],
    }));

    const reviewLogGroup = new logs.LogGroup(this, 'ReviewLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const reviewFunction = new lambdaNodejs.NodejsFunction(this, 'ReviewFunction', {
      entry: path.join(HERE, '..', '..', 'functions', 'review-handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(15),
      logGroup: reviewLogGroup,
      tracing: lambda.Tracing.ACTIVE,
      bundling: { minify: true, sourceMap: false, target: 'node22' },
      environment: {
        ALLOWED_INTERNAL_CIDRS: JSON.stringify(props.allowedInternalCidrs),
        CLOUDFRONT_KEY_PAIR_ID: publicKey.publicKeyId,
        CONSOLE_ORIGIN: consoleOrigin,
        CONTENT_ORIGIN: contentOrigin,
        MAXIMUM_SHARE_DAYS: String(props.maximumShareDays),
        PRIVATE_KEY_PARAMETER_NAME: props.privateKeyParameterName,
        REVIEW_TABLE_NAME: reviewTable.tableName,
      },
    });
    reviewTable.grantReadWriteData(reviewFunction);
    reviewFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [privateKeyParameter.parameterArn],
    }));

    const authUrl = authFunction.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
    const reviewUrl = reviewFunction.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
    const authOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(authUrl);
    const reviewOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(reviewUrl);
    const consoleS3Origin = origins.S3BucketOrigin.withOriginAccessControl(consoleBucket);
    const consoleHeaders = securityPolicy(this, 'ConsoleHeaders', false, consoleOrigin, contentOrigin);
    const common = {
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      responseHeadersPolicy: consoleHeaders,
      compress: true,
    };
    const consoleDistribution = new cloudfront.Distribution(this, 'ConsoleDistribution', {
      domainNames: [props.consoleDomain],
      certificate,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        ...common,
        origin: consoleS3Origin,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      },
      additionalBehaviors: {
        'app/*': {
          ...common,
          origin: consoleS3Origin,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          trustedKeyGroups: [keyGroup],
        },
        'review/*': {
          ...common,
          origin: consoleS3Origin,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          trustedKeyGroups: [keyGroup],
        },
        'auth/*': {
          ...common,
          origin: authOrigin,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
        'api/owner/*': {
          ...common,
          origin: reviewOrigin,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          trustedKeyGroups: [keyGroup],
        },
        'api/device/*': {
          ...common,
          origin: reviewOrigin,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
        'api/pairings/*': {
          ...common,
          origin: reviewOrigin,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
    });

    for (const [name, fn] of [['Auth', authFunction], ['Review', reviewFunction]] as const) {
      fn.addPermission(`CloudFrontInvoke${name}Url`, {
        principal: new iam.ServicePrincipal('cloudfront.amazonaws.com'),
        action: 'lambda:InvokeFunction',
        sourceArn: this.formatArn({
          service: 'cloudfront', region: '', resource: 'distribution', resourceName: consoleDistribution.distributionId,
        }),
        invokedViaFunctionUrl: true,
      });
    }

    new CfnOutput(this, 'ConsoleBucketName', { value: consoleBucket.bucketName });
    new CfnOutput(this, 'ContentBucketName', { value: contentBucket.bucketName });
    new CfnOutput(this, 'ConsoleUrl', { value: consoleOrigin });
    new CfnOutput(this, 'ContentUrl', { value: `https://${props.contentDomain}` });
    new CfnOutput(this, 'ConsoleCloudFrontDomain', { value: consoleDistribution.distributionDomainName });
    new CfnOutput(this, 'ContentCloudFrontDomain', { value: contentDistribution.distributionDomainName });
    new CfnOutput(this, 'CloudFrontPublicKeyId', { value: publicKey.publicKeyId });
    new CfnOutput(this, 'ReviewTableName', { value: reviewTable.tableName });
  }
}
