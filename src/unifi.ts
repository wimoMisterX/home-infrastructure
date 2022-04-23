import * as pulumi from '@pulumi/pulumi'
import * as aws from '@pulumi/aws'
import * as awsx from '@pulumi/awsx'
import { ValidateCertificate } from '@wanews/pulumi-certificate-validation'

export class UnifiController extends pulumi.ComponentResource {
  webAdminUrl: pulumi.Output<string>

  constructor(
    name: string,
    args: {
      controllerVersion: pulumi.Input<string>
      hostname: pulumi.Input<string>
      zoneName: pulumi.Input<string>
    },
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super('unifi-controller', name, args, opts)

    const zone = aws.route53.getZoneOutput(
      {
        name: args.zoneName,
        privateZone: false,
      },
      { parent: this },
    )

    const cert = new aws.acm.Certificate(
      `${name}-cert`,
      {
        domainName: args.hostname,
        validationMethod: 'DNS',
      },
      { parent: this },
    )

    const validatedCert = new ValidateCertificate(
      `${name}-cert-validation`,
      {
        cert,
        zones: [
          {
            domain: zone.name,
            zoneId: zone.zoneId,
          },
        ],
      },
      { parent: this },
    )

    const alb = new awsx.lb.ApplicationLoadBalancer(
      `${name}-alb`,
      {
        name: `${name}-alb`,
      },
      { parent: this },
    )

    const albWebAdminTargetGroup = alb.createTargetGroup(
      `${name}-alb-web-admin-tg`,
      {
        name: `${name}-alb-8443`,
        port: 8443,
        protocol: 'HTTPS',
        deregistrationDelay: 60,
      },
      { parent: this },
    )

    const albWebAdminListener = alb.createListener(
      `${name}-web-admin-listener`,
      {
        targetGroup: albWebAdminTargetGroup,
        port: 8443,
        protocol: 'HTTPS',
        certificateArn: validatedCert.validCertificateArn,
      },
      { parent: this },
    )

    const albGuestPortalTargetGroup = alb.createTargetGroup(
      `${name}-alb-guest-portal-tg`,
      {
        name: `${name}-alb-8843`,
        port: 8843,
        protocol: 'HTTPS',
        deregistrationDelay: 60,
      },
      { parent: this },
    )

    const albGuestPortalListener = alb.createListener(
      `${name}-guest-portal-listener`,
      {
        targetGroup: albGuestPortalTargetGroup,
        port: 8843,
        protocol: 'HTTPS',
        certificateArn: validatedCert.validCertificateArn,
      },
      { parent: this },
    )

    const nlb = new awsx.lb.NetworkLoadBalancer(
      `${name}-nlb`,
      {
        name: `${name}-nlb`,
      },
      { parent: this },
    )

    const nlbWebAdminTargetGroup = new aws.lb.TargetGroup(
      `${name}-nlb-web-admin-tg`,
      {
        name: `${name}-nlb-8443`,
        port: 8443,
        protocol: 'TCP',
        targetType: 'alb',
        vpcId: nlb.vpc.id,
      },
      { parent: this },
    )

    new aws.lb.TargetGroupAttachment(
      `${name}-nlb-web-admin-tg-attach`,
      {
        targetGroupArn: nlbWebAdminTargetGroup.arn,
        targetId: alb.loadBalancer.id,
      },
      { parent: this, dependsOn: [albWebAdminListener] },
    )

    new aws.lb.Listener(
      `${name}-nlb-web-admin-listener`,
      {
        loadBalancerArn: nlb.loadBalancer.arn,
        port: 8443,
        protocol: 'TCP',
        defaultActions: [
          { type: 'forward', targetGroupArn: nlbWebAdminTargetGroup.arn },
        ],
      },
      { parent: this },
    )

    const nlbGuestPortalTargetGroup = new aws.lb.TargetGroup(
      `${name}-nlb-guest-portal-tg`,
      {
        name: `${name}-nlb-8843`,
        port: 8843,
        protocol: 'TCP',
        targetType: 'alb',
        vpcId: nlb.vpc.id,
      },
      { parent: this },
    )

    new aws.lb.TargetGroupAttachment(
      `${name}-nlb-guest-portal-tg-attach`,
      {
        targetGroupArn: nlbGuestPortalTargetGroup.arn,
        targetId: alb.loadBalancer.id,
      },
      { parent: this, dependsOn: [albGuestPortalListener] },
    )

    new aws.lb.Listener(
      `${name}-nlb-guest-portal-listener`,
      {
        loadBalancerArn: nlb.loadBalancer.arn,
        port: 8843,
        protocol: 'TCP',
        defaultActions: [
          { type: 'forward', targetGroupArn: nlbGuestPortalTargetGroup.arn },
        ],
      },
      { parent: this },
    )

    const nlbStunTargetGroup = nlb.createTargetGroup(
      `${name}-nlb-stun-tg`,
      {
        name: `${name}-nlb-3478`,
        port: 3478,
        protocol: 'UDP',
        deregistrationDelay: 60,
      },
      { parent: this },
    )

    const nlbStunListener = nlb.createListener(
      `${name}-stun-listener`,
      { port: 3478, protocol: 'UDP', targetGroup: nlbStunTargetGroup },
      { parent: this },
    )

    for (const dnsType of ['A', 'AAAA']) {
      new aws.route53.Record(
        `${name}-dns-${dnsType}`,
        {
          name: args.hostname,
          type: dnsType,
          aliases: [
            {
              name: nlb.loadBalancer.dnsName,
              zoneId: nlb.loadBalancer.zoneId,
              evaluateTargetHealth: false,
            },
          ],
          zoneId: zone.zoneId,
        },
        { parent: this },
      )
    }

    const controllerService = new awsx.ecs.FargateService(
      `${name}-fargate-service`,
      {
        taskDefinitionArgs: {
          containers: {
            'unifi-controller': {
              image: `lscr.io/linuxserver/unifi-controller:${args.controllerVersion}`,
              memory: 1024,
              cpu: 1024,
              environment: [
                {
                  name: 'PUID',
                  value: '1000',
                },
                {
                  name: 'PGID',
                  value: '1000',
                },
                {
                  name: 'MEM_LIMIT',
                  value: '1024',
                },
                {
                  name: 'MEM_STARTUP',
                  value: '512',
                },
              ],
              portMappings: [
                albWebAdminListener,
                albGuestPortalListener,
                nlbStunListener,
              ],
            },
          },
        },
        desiredCount: 1,
      },
      { parent: this },
    )

    this.webAdminUrl = pulumi.interpolate`https://${args.hostname}:8443`
  }
}
