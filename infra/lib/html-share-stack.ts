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
import * as customResources from 'aws-cdk-lib/custom-resources';
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
  uploadOrigin = '',
): cloudfront.ResponseHeadersPolicy {
  // 管理面の img-src の blob: は添付する画像のサムネイル、connect-src の uploadOrigin は
  // スマホの画像を一時置き場へ直接 POST するため
  const csp = content
    ? `default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data:; font-src data:; media-src data:; frame-src 'none'; connect-src 'none'; form-action 'none'; frame-ancestors ${consoleOrigin}; base-uri 'none'; sandbox allow-scripts`
    : `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ${uploadOrigin}; frame-src ${contentOrigin}; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`;
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
        // nosnippet / noimageindex は付けない（2026-09-20）。検索エンジンには noindex が
        // 効いているので重複でしかない一方、リンクプレビューのクローラーがこれを読むと
        // 「説明文を出すな」「画像を出すな」と受け取り、カードを縮める側にしか働かない。
        { header: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive', override: true },
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

    // スマホから送る画像の一時置き場。ブラウザが署名付き POST で直接置き、PCが取り込んだら
    // その場で消す。取り込み忘れは7日で消える。配信（CloudFront）からは読ませず、
    // Review API が発行する署名付きURLでだけ出し入れする。
    const uploadBucket = new s3.Bucket(this, 'UploadBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: false,
      lifecycleRules: [{ expiration: Duration.days(7), abortIncompleteMultipartUploadAfter: Duration.days(1) }],
      cors: [{
        allowedOrigins: [consoleOrigin],
        allowedMethods: [s3.HttpMethods.POST],
        allowedHeaders: ['*'],
        maxAge: 3600,
      }],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const uploadOrigin = `https://${uploadBucket.bucketRegionalDomainName}`;

    const publicKey = new cloudfront.PublicKey(this, 'SigningPublicKey', {
      encodedKey: props.publicKeyPem,
      comment: 'HTML Share signed URL verification key',
    });
    const keyGroup = new cloudfront.KeyGroup(this, 'SigningKeyGroup', {
      items: [publicKey],
      comment: 'HTML Share trusted signers',
    });

    // 既定の CachingDisabled は圧縮も止める（gzip・brotli を受け付けない）。compress: true と書いても
    // 圧縮されず、ページや一覧の JSON がそのままの大きさで流れる。そこで S3 から配る分だけ、
    // キャッシュはしないが圧縮はするポリシーに替える。
    // 既定のTTLを0にしておけば、Cache-Control の無いオブジェクトも no-store のオブジェクトもエッジに残らない。
    // 最大TTLを1秒にしているのは、TTLがすべて0だと圧縮の設定を受け付けないため。
    // 署名付きCookie・URLの検証はキャッシュより手前で毎回行われるので、エッジに残っても素通りはしない。
    // Lambda（auth/*・api/*）は Cookie で応答が変わるので、従来どおり CachingDisabled のまま。
    const siteCachePolicy = new cloudfront.CachePolicy(this, 'SiteCachePolicy', {
      comment: 'No caching (TTL 0) but gzip/brotli compression enabled',
      defaultTtl: Duration.seconds(0),
      minTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(1),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
    });

    const contentBucketOrigin = origins.S3BucketOrigin.withOriginAccessControl(contentBucket);
    const contentHeaders = securityPolicy(this, 'ContentHeaders', true, consoleOrigin, contentOrigin);
    const contentDistribution = new cloudfront.Distribution(this, 'ContentDistribution', {
      domainNames: [props.contentDomain],
      certificate,
      defaultBehavior: {
        origin: contentBucketOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: siteCachePolicy,
        responseHeadersPolicy: contentHeaders,
        trustedKeyGroups: [keyGroup],
        compress: true,
      },
      // リンクプレビューの画像だけは署名なしで開ける。Slack・Teams・X のクローラーは
      // 署名を持たずに og:image を取りに来るため。置くのは全ページ共通のカード画像1枚だけで、
      // ページの中身はここに置かない（publish が og/ へ書くのは assets/og-card.jpg のみ）。
      additionalBehaviors: {
        'og/*': {
          origin: contentBucketOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: siteCachePolicy,
          responseHeadersPolicy: contentHeaders,
          compress: true,
        },
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
      // Cognito はパスキーを有効にするとき PASSWORD も有効であることを求める。
      // 本人ユーザーはパスワードなしで作るので、実際に使うのはパスキーとメールのワンタイムコードだけ。
      signInPolicy: { allowedFirstAuthFactors: { password: true, emailOtp: true, passkey: true } },
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
        // COGNITO_ADMIN は、ログイン直後にパスキーの有無を数える ListWebAuthnCredentials 用
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.COGNITO_ADMIN],
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
    const ownerDomain = userPool.addDomain('OwnerDomain', {
      cognitoDomain: { domainPrefix: props.cognitoDomainPrefix },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    // パスキーの RP ID は Cognito のログイン画面のドメインにする。一覧側の名前を替えても
    // 登録済みのパスキーがそのまま使える。ユーザープールの作成と同時には、まだ無いドメインを
    // RP ID に指定できないので、ドメインができてから設定APIを呼ぶ。
    const passkeyParameters = {
      UserPoolId: userPool.userPoolId,
      WebAuthnConfiguration: {
        RelyingPartyId: `${props.cognitoDomainPrefix}.auth.${this.region}.amazoncognito.com`,
        UserVerification: 'required',
        FactorConfiguration: 'SINGLE_FACTOR',
      },
    };
    const passkeyConfig = new customResources.AwsCustomResource(this, 'PasskeyConfiguration', {
      onCreate: {
        service: 'CognitoIdentityServiceProvider',
        action: 'setUserPoolMfaConfig',
        parameters: passkeyParameters,
        physicalResourceId: customResources.PhysicalResourceId.of('html-share-passkey-config'),
      },
      onUpdate: {
        service: 'CognitoIdentityServiceProvider',
        action: 'setUserPoolMfaConfig',
        parameters: passkeyParameters,
        physicalResourceId: customResources.PhysicalResourceId.of('html-share-passkey-config'),
      },
      policy: customResources.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['cognito-idp:SetUserPoolMfaConfig'],
          resources: [userPool.userPoolArn],
        }),
      ]),
      installLatestAwsSdk: false,
      logGroup: new logs.LogGroup(this, 'PasskeyConfigLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    passkeyConfig.node.addDependency(ownerDomain);

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
      // 署名付きPOSTとS3の署名付きURLの部品は Lambda の実行環境に入っている保証がないので同梱する
      bundling: { minify: true, sourceMap: false, target: 'node22', bundleAwsSDK: true },
      environment: {
        ALLOWED_INTERNAL_CIDRS: JSON.stringify(props.allowedInternalCidrs),
        CLOUDFRONT_KEY_PAIR_ID: publicKey.publicKeyId,
        CONSOLE_ORIGIN: consoleOrigin,
        CONTENT_ORIGIN: contentOrigin,
        MAXIMUM_SHARE_DAYS: String(props.maximumShareDays),
        PRIVATE_KEY_PARAMETER_NAME: props.privateKeyParameterName,
        REVIEW_TABLE_NAME: reviewTable.tableName,
        UPLOAD_BUCKET_NAME: uploadBucket.bucketName,
        UPLOAD_BUCKET_ORIGIN: uploadOrigin,
      },
    });
    reviewTable.grantReadWriteData(reviewFunction);
    // 署名付きURLはこの Lambda の権限で署名されるので、置く・読む・消すの3つを持たせる
    reviewFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'],
      resources: [uploadBucket.arnForObjects('inbox/*')],
    }));
    reviewFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [privateKeyParameter.parameterArn],
    }));

    const authUrl = authFunction.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
    const reviewUrl = reviewFunction.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
    const authOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(authUrl);
    const reviewOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(reviewUrl);
    const consoleS3Origin = origins.S3BucketOrigin.withOriginAccessControl(consoleBucket);
    const consoleHeaders = securityPolicy(this, 'ConsoleHeaders', false, consoleOrigin, contentOrigin, uploadOrigin);
    const common = {
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      responseHeadersPolicy: consoleHeaders,
      compress: true,
    };
    // S3 から配る画面と一覧（既定・app/*・review/*）は、キャッシュせずに圧縮する
    const site = { ...common, cachePolicy: siteCachePolicy };
    // 一覧側の /pages/<slug>/… は、一覧アプリでそのページを開く URL（/app/index.html#/<slug>）へ送る。
    // 本文と同じ形のURLを一覧側に貼ってしまったときや、別の配信から移したページの古いリンクを生かすため
    const pageLinkFunction = new cloudfront.Function(this, 'PageLinkFunction', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`function handler(event) {
  var request = event.request;
  var match = request.uri.match(/^\\/pages\\/([a-z0-9-]+)(\\/|$)/);
  if (!match) return request;
  return {
    statusCode: 302,
    statusDescription: 'Found',
    headers: {
      location: { value: '/app/index.html#/' + match[1] },
      'cache-control': { value: 'no-store' },
    },
  };
}`),
    });
    const consoleDistribution = new cloudfront.Distribution(this, 'ConsoleDistribution', {
      domainNames: [props.consoleDomain],
      certificate,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        ...site,
        origin: consoleS3Origin,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        functionAssociations: [{ function: pageLinkFunction, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        'app/*': {
          ...site,
          origin: consoleS3Origin,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          trustedKeyGroups: [keyGroup],
        },
        'review/*': {
          ...site,
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
    new CfnOutput(this, 'UploadBucketName', { value: uploadBucket.bucketName });
  }
}
