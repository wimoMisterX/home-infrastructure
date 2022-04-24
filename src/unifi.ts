import * as pulumi from '@pulumi/pulumi'
import * as aws from '@pulumi/aws'
import * as awsx from '@pulumi/awsx'
import { setupAlbListener, setupNlbListener } from './utils'

export class UnifiController extends pulumi.ComponentResource {
  webAdminUrl: pulumi.Output<string>

  constructor(
    name: string,
    args: {
      vpc: awsx.ec2.Vpc
      ecsCluster: awsx.ecs.Cluster
      ecsSubnetIds: pulumi.Input<string[]>
      albCertArn: pulumi.Input<string>
      alb: awsx.elasticloadbalancingv2.ApplicationLoadBalancer
      nlb: awsx.elasticloadbalancingv2.NetworkLoadBalancer
      controllerVersion: pulumi.Input<string>
      hostname: pulumi.Input<string>
      zoneId: pulumi.Input<string>
    },
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super('unifi-controller', name, args, opts)

    const albWebAdminListener = setupAlbListener(
      args.alb,
      'home-alb',
      8443,
      'HTTPS',
      args.albCertArn,
    )
    setupNlbListener(args.nlb, 'home-nlb', 8443, 'TCP', albWebAdminListener)
    const albWebAdminTargetGroup = args.alb.createTargetGroup(
      `${name}-alb-web-admin-tg`,
      {
        name: `${name}-alb-8443`,
        port: 8443,
        protocol: 'HTTPS',
        deregistrationDelay: 60,
        healthCheck: {
          protocol: 'HTTPS',
          path: '/',
          matcher: '200,302',
        },
      },
      { parent: this },
    )
    albWebAdminListener.addListenerRule(
      `${name}-alb-web-admin-rule`,
      {
        conditions: [{ hostHeader: { values: [args.hostname] } }],
        actions: [
          {
            type: 'forward',
            targetGroupArn: albWebAdminTargetGroup.targetGroup.arn,
          },
        ],
      },
      { parent: this },
    )

    const albGuestPortalListener = setupAlbListener(
      args.alb,
      'home-alb',
      8843,
      'HTTPS',
      args.albCertArn,
    )
    setupNlbListener(args.nlb, 'home-nlb', 8843, 'TCP', albGuestPortalListener)
    const albGuestPortalTargetGroup = args.alb.createTargetGroup(
      `${name}-alb-guest-portal-tg`,
      {
        name: `${name}-alb-8843`,
        port: 8843,
        protocol: 'HTTPS',
        deregistrationDelay: 60,
        healthCheck: {
          protocol: 'HTTPS',
          path: '/',
          port: '8443',
          matcher: '200,302',
        },
      },
      { parent: this },
    )
    albGuestPortalListener.addListenerRule(
      `${name}-alb-guest-portal-rule`,
      {
        conditions: [{ hostHeader: { values: [args.hostname] } }],
        actions: [
          {
            type: 'forward',
            targetGroupArn: albGuestPortalTargetGroup.targetGroup.arn,
          },
        ],
      },
      { parent: this },
    )

    const nlbStunListener = setupNlbListener(
      args.nlb,
      'home-nlb',
      3478,
      'UDP',
      undefined,
      {
        deregistrationDelay: 60,
        healthCheck: {
          protocol: 'TCP',
          port: '8443',
        },
      },
    )

    for (const dnsType of ['A', 'AAAA']) {
      new aws.route53.Record(
        `${name}-dns-${dnsType}`,
        {
          name: args.hostname,
          type: dnsType,
          aliases: [
            {
              name: args.nlb.loadBalancer.dnsName,
              zoneId: args.nlb.loadBalancer.zoneId,
              evaluateTargetHealth: false,
            },
          ],
          zoneId: args.zoneId,
        },
        { parent: this },
      )
    }

    const taskSecurityGroup = new awsx.ec2.SecurityGroup(
      `${name}-fargate-task-sg`,
      {
        vpc: args.vpc,
      },
    )
    awsx.ec2.SecurityGroupRule.ingress(
      `${name}-fargate-task-any-ingress`,
      taskSecurityGroup,
      new awsx.ec2.AnyIPv4Location(),
      new awsx.ec2.AllTraffic(),
      'allow everywhere',
    )
    awsx.ec2.SecurityGroupRule.egress(
      `${name}-fargate-task-any-egress`,
      taskSecurityGroup,
      new awsx.ec2.AnyIPv4Location(),
      new awsx.ec2.AllTraffic(),
      'allow everywhere',
    )

    new awsx.ecs.FargateService(
      `${name}-fargate-service`,
      {
        cluster: args.ecsCluster,
        subnets: args.ecsSubnetIds,
        securityGroups: [taskSecurityGroup],
        assignPublicIp: false,
        healthCheckGracePeriodSeconds: 60,
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
                albWebAdminTargetGroup,
                albGuestPortalTargetGroup,
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
