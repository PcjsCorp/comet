import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { Contract, ethers } from 'ethers';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { diffState, getCometConfig } from '../../../../plugins/deployment_manager/DiffState';
import {
  calldata,
  exp,
  getConfigurationStruct,
  proposal,
} from '../../../../src/deploy';
import { expect } from 'chai';

const ENSName = 'compound-community-licenses.eth';
const ENSResolverAddress = '0x4976fb03C32e5B8cfe2b6cCB31c09Ba78EBaBa41';
const ENSRegistryAddress = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
const ENSSubdomainLabel = 'v3-additional-grants';
const ENSSubdomain = `${ENSSubdomainLabel}.${ENSName}`;
const ENSTextRecordKey = 'v3-official-markets';
const opCOMPAddress = '0x7e7d4467112689329f7E06571eD0E8CbAd4910eE';
const USDTAmountToBridge = exp(10_000, 6);
const cUSDTAddress = '0xf650c3d88d12db855b8bf7d11be6c55a4e07dcc9';
const mainnetUSDTAddress = '0xdac17f958d2ee523a2206206994597c13d831ec7';

export default migration('1713012100_configurate_and_ens', {
  prepare: async (deploymentManager: DeploymentManager) => {
    return {};
  },

  enact: async (
    deploymentManager: DeploymentManager,
    govDeploymentManager: DeploymentManager
  ) => {
    const trace = deploymentManager.tracer();
    const { utils } = ethers;

    const cometFactory = await deploymentManager.fromDep(
      'cometFactory',
      'optimism',
      'usdc'
    );
    const {
      bridgeReceiver,
      timelock: localTimelock,
      comet,
      cometAdmin,
      configurator,
      rewards,
      USDT
    } = await deploymentManager.getContracts();

    const {
      opL1CrossDomainMessenger,
      opL1StandardBridge,
      governor,
      timelock
    } = await govDeploymentManager.getContracts();

    // ENS Setup
    // See also: https://docs.ens.domains/contract-api-reference/name-processing
    const ENSResolver = await govDeploymentManager.existing(
      'ENSResolver',
      ENSResolverAddress
    );
    const subdomainHash = ethers.utils.namehash(ENSSubdomain);
    const opChainId = (
      await deploymentManager.hre.ethers.provider.getNetwork()
    ).chainId.toString();
    const newMarketObject = { baseSymbol: 'USDT', cometAddress: comet.address };
    const officialMarketsJSON = JSON.parse(
      await ENSResolver.text(subdomainHash, ENSTextRecordKey)
    );
    if (officialMarketsJSON[opChainId]) {
      officialMarketsJSON[opChainId].push(newMarketObject);
    } else {
      officialMarketsJSON[opChainId] = [newMarketObject];
    }

    const configuration = await getConfigurationStruct(deploymentManager);
    const setFactoryCalldata = await calldata(
      configurator.populateTransaction.setFactory(
        comet.address,
        cometFactory.address
      )
    );
    const setConfigurationCalldata = await calldata(
      configurator.populateTransaction.setConfiguration(
        comet.address,
        configuration
      )
    );
    const deployAndUpgradeToCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address'],
      [configurator.address, comet.address]
    );
    const setRewardConfigCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address'],
      [comet.address, opCOMPAddress]
    );

    const l2ProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [
          configurator.address,
          configurator.address,
          cometAdmin.address,
          rewards.address,
        ],
        [0, 0, 0, 0],
        [
          'setFactory(address,address)',
          'setConfiguration(address,(address,address,address,address,address,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint104,uint104,uint104,(address,address,uint8,uint64,uint64,uint64,uint128)[]))',
          'deployAndUpgradeTo(address,address)',
          'setRewardConfig(address,address)',
        ],
        [
          setFactoryCalldata,
          setConfigurationCalldata,
          deployAndUpgradeToCalldata,
          setRewardConfigCalldata,
        ],
      ]
    );

    const USDTMainnet = new Contract(
      mainnetUSDTAddress,
      [
        'function balanceOf(address account) external view returns (uint256)',
        'function approve(address,uint256) external'
      ],
      govDeploymentManager.hre.ethers.provider
    );

    const notEnoughUSDT = (await USDTMainnet.balanceOf(timelock.address)).lt(USDTAmountToBridge);
    const amountToSupply = notEnoughUSDT ? ethers.BigNumber.from(USDTAmountToBridge).sub(await USDTMainnet.balanceOf(timelock.address)) : 0;
    const _reduceReservesCalldata = utils.defaultAbiCoder.encode(
      ['uint256'],
      [amountToSupply]
    );

    // COMP speeds for rewards are setted, but the bridge of tokens does not happen, because it was bridged in the USDC market proposal 

    const actions = [
      // 1. Set Comet configuration + deployAndUpgradeTo new Comet, set Reward Config on Optimism
      {
        contract: opL1CrossDomainMessenger,
        signature: 'sendMessage(address,bytes,uint32)',
        args: [bridgeReceiver.address, l2ProposalData, 3_000_000],
      },
      // 2. Get USDT reserves from cUSDT contract
      {
        target: cUSDTAddress,
        signature: '_reduceReserves(uint256)',
        calldata: _reduceReservesCalldata
      },
      // 3. Approve USDT to L1StandardBridge
      {
        contract: USDTMainnet,
        signature: 'approve(address,uint256)',
        args: [opL1StandardBridge.address, USDTAmountToBridge],
      },
      // 4. Bridge USDT from Ethereum to OP Comet using L1StandardBridge
      {
        contract: opL1StandardBridge,
        // function depositERC20To(address _l1Token, address _l2Token, address _to, uint256 _amount, uint32 _l2Gas,bytes calldata _data)
        signature:
          'depositERC20To(address,address,address,uint256,uint32,bytes)',
        args: [
          USDTMainnet.address,
          USDT.address,
          comet.address,
          USDTAmountToBridge,
          200_000,
          '0x',
        ],
      },
      // 5. Update the list of official markets
      {
        target: ENSResolverAddress,
        signature: 'setText(bytes32,string,string)',
        calldata: ethers.utils.defaultAbiCoder.encode(
          ['bytes32', 'string', 'string'],
          [subdomainHash, ENSTextRecordKey, JSON.stringify(officialMarketsJSON)]
        ),
      },
    ];

    // the description has speeds. speeds will be set up on on-chain proposal
    const description = "# Initialize cUSDTv3 on Optimism\n\n## Proposal summary\n\nCompound Growth Program [AlphaGrowth] proposes the deployment of Compound III to the Optimism network. This proposal takes the governance steps recommended and necessary to initialize a Compound III USDT market on Optimism; upon execution, cUSDTv3 will be ready for use. Simulations have confirmed the market’s readiness, as much as possible, using the [Comet scenario suite](https://github.com/compound-finance/comet/tree/main/scenario). The new parameters include setting the risk parameters based on the [recommendations from Gauntlet](https://www.comp.xyz/t/deploy-compound-iii-on-optimism/4975/6).\n\nFurther detailed information can be found on the corresponding [proposal pull request](https://github.com/compound-finance/comet/pull/848) and [forum discussion](https://www.comp.xyz/t/deploy-compound-iii-on-optimism/4975).\n\n\n## Proposal Actions\n\nThe first proposal action sets the Comet configuration and deploys a new Comet implementation on Optimism. This sends the encoded `setFactory`, `setConfiguration` and `deployAndUpgradeTo` calls across the bridge to the governance receiver on Optimism. It also calls `setRewardConfig` on the Optimism rewards contract, to establish Optimism’s bridged version of COMP as the reward token for the deployment and set the initial supply speed to be 5 COMP/day and borrow speed to be 5 COMP/day.\n\nThe second action reduces Compound [cUSDT](https://etherscan.io/address/0xf650c3d88d12db855b8bf7d11be6c55a4e07dcc9) reserves to Timelock, in order to seed the market reserves through the Optimism L1StandardBridge.\n\nThe third action approves Optimism’s [L1StandardBridge](https://etherscan.io/address/0x99C9fc46f92E8a1c0deC1b1747d010903E884bE1) to take Timelock's USDT, in order to seed the reserves through the bridge.\n\nThe fourth action deposits 10K USDT from mainnet to the Optimism L1StandardBridge contract to bridge to Comet.\n\nThe fifth action updates the ENS TXT record `v3-official-markets` on `v3-additional-grants.compound-community-licenses.eth`, updating the official markets JSON to include the new Optimism cUSDTv3 market";
    const txn = await govDeploymentManager.retry(async () => {
      return trace(await governor.propose(...(await proposal(actions, description))));
    }
    );

    const event = txn.events.find((event) => event.event === 'ProposalCreated');
    const [proposalId] = event.args;

    trace(`Created proposal ${proposalId}.`);
  },

  async enacted(deploymentManager: DeploymentManager): Promise<boolean> {
    return true;
  },

  async verify(deploymentManager: DeploymentManager, govDeploymentManager: DeploymentManager, preMigrationBlockNumber: number) {
    const ethers = deploymentManager.hre.ethers;

    const {
      comet,
      rewards,
      WBTC,
      WETH,
      OP,
      COMP
    } = await deploymentManager.getContracts();

    const {
      timelock
    } = await govDeploymentManager.getContracts();

    const stateChanges = await diffState(comet, getCometConfig, preMigrationBlockNumber);

    // uncomment on on-chain proposal PR
    // expect(stateChanges).to.deep.equal({
    //   WBTC: {
    //     supplyCap: exp(400, 8)
    //   },
    //   WETH: {
    //     supplyCap: exp(11_000, 18)
    //   },
    //   OP: {
    //     supplyCap: exp(10_000_000, 18)
    //   },
    //   baseTrackingSupplySpeed: exp(5 / 86400, 15, 18), 
    //   baseTrackingBorrowSpeed: exp(5 / 86400, 15, 18),
    // });

    const config = await rewards.rewardConfig(comet.address);
    expect(config.token).to.be.equal(COMP.address);
    expect(config.rescaleFactor).to.be.equal(exp(1, 12));
    expect(config.shouldUpscale).to.be.equal(true);

    // 2. & 3 & 4.
    expect(await comet.getReserves()).to.be.equal(USDTAmountToBridge);

    // 5.
    const ENSResolver = await govDeploymentManager.existing(
      "ENSResolver",
      ENSResolverAddress
    );
    const subdomainHash = ethers.utils.namehash(ENSSubdomain);
    const officialMarketsJSON = await ENSResolver.text(
      subdomainHash,
      ENSTextRecordKey
    );
    const officialMarkets = JSON.parse(officialMarketsJSON);
    expect(officialMarkets).to.deep.equal({
      1: [
        {
          baseSymbol: 'USDC',
          cometAddress: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
        },
        {
          baseSymbol: 'WETH',
          cometAddress: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
        },
      ],
      137: [
        {
          baseSymbol: 'USDC',
          cometAddress: '0xF25212E676D1F7F89Cd72fFEe66158f541246445',
        },
      ],
      8453: [
        {
          baseSymbol: 'USDbC',
          cometAddress: '0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf',
        },
        {
          baseSymbol: 'WETH',
          cometAddress: '0x46e6b214b524310239732D51387075E0e70970bf',
        },
        {
          baseSymbol: 'USDC',
          cometAddress: '0xb125E6687d4313864e53df431d5425969c15Eb2F',
        },
      ],
      42161: [
        {
          baseSymbol: 'USDC.e',
          cometAddress: '0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA',
        },
        {
          baseSymbol: 'USDC',
          cometAddress: '0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf',
        },
      ],
      534352: [
        {
          baseSymbol: 'USDC',
          cometAddress: '0xB2f97c1Bd3bf02f5e74d13f02E3e26F93D77CE44',
        },
      ],
      10: [
        {
          baseSymbol: 'USDC',
          cometAddress: '0x2e44e174f7D53F0212823acC11C01A11d58c5bCB',
        },
        {
          baseSymbol: 'USDT',
          cometAddress: comet.address,
        },
      ],
    });
  }
});