import * as pulumi from '@pulumi/pulumi'
import * as aws from '@pulumi/aws'
import * as awsx from '@pulumi/awsx'
import { getSubnetIds, setupAlbListener, setupNlbListener } from './utils'
import { ValidateCertificate } from '@wanews/pulumi-certificate-validation'
import { UnifiController } from './unifi'

const albConfig = new pulumi.Config('alb')
const unifiConfig = new pulumi.Config('unifi')

const vpc = new awsx.ec2.Vpc('home-vpc', {
  cidrBlock: '10.0.0.0/16',
  numberOfAvailabilityZones: 2,
  numberOfNatGateways: 1,
  subnets: [
    { type: 'public', name: 'lb' },
    { type: 'private', name: 'ecs' },
    { type: 'isolated', name: 'efs' },
  ],
})

const lbSubnetIds = getSubnetIds(vpc.publicSubnets, 'lb')
const efsSubnetIds = getSubnetIds(vpc.isolatedSubnets, 'efs')
const ecsSubnetIds = getSubnetIds(vpc.privateSubnets, 'ecs')

const ecsCluster = new awsx.ecs.Cluster('home-cluster', {
  capacityProviders: ['FARGATE_SPOT'],
  securityGroups: [],
  defaultCapacityProviderStrategies: [{ capacityProvider: 'FARGATE_SPOT' }],
  vpc,
})

const zone = aws.route53.getZoneOutput({
  name: albConfig.require('default-acm-certificate-domain-route53-zone-name'),
  privateZone: false,
})

const albCert = new ValidateCertificate(`alb-cert-validation`, {
  cert: new aws.acm.Certificate('alb-cert', {
    domainName: albConfig.require('default-acm-certificate-domain'),
    validationMethod: 'DNS',
  }),
  zones: [
    {
      domain: zone.name,
      zoneId: zone.zoneId,
    },
  ],
})

const albSecurityGroup = new awsx.ec2.SecurityGroup('home-alb-sg', { vpc })

const alb = new awsx.lb.ApplicationLoadBalancer('home-alb', {
  subnets: lbSubnetIds,
  vpc,
  securityGroups: [albSecurityGroup],
})

const albHttps8443Listener = setupAlbListener(
  alb,
  'home-alb',
  8443,
  'HTTPS',
  albCert.validCertificateArn,
)
const albHttps8843Listener = setupAlbListener(
  alb,
  'home-alb',
  8843,
  'HTTPS',
  albCert.validCertificateArn,
)

const nlb = new awsx.lb.NetworkLoadBalancer('home-nlb', {
  subnets: lbSubnetIds,
  vpc,
})

setupNlbListener(nlb, 'home-nlb', 8443, 'TCP', albHttps8443Listener)
setupNlbListener(nlb, 'home-nlb', 8843, 'TCP', albHttps8843Listener)
const nlbUdp3478Listener = setupNlbListener(nlb, 'home-nlb', 3478, 'UDP')

const homeUnifiController = new UnifiController('home-unifi-controller', {
  vpc,
  ecsSubnetIds,
  ecsCluster,
  https8443Listener: albHttps8443Listener,
  https8843Listener: albHttps8843Listener,
  udp3478Listener: nlbUdp3478Listener,
  controllerVersion: unifiConfig.require('controller-version'),
  zoneId: zone.zoneId,
  hostname: unifiConfig.require('hostname'),
})

export const homeUnifiControllerWebAdminUrl = homeUnifiController.webAdminUrl
