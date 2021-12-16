const { expect } = require("chai");
const { ethers } = require("hardhat");
const { BigNumber } = require("ethers");
const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");


const {
  verifyBalance,
  verifyBalances,
  verifyAllowance,
  verifyPoolsStatus,
  verifyPoolsStatus_legacy,
  verifyPoolsStatusForIndex_legacy,
  verifyPoolsStatusOf,
  verifyDebtOf,
  verifyIndexStatus,
  verifyVaultStatus,
  verifyVaultStatusOf,
  verifyValueOfUnderlying,
} = require('../test-utils')


const {
  ZERO_ADDRESS,
  long,
  wrong,
  short,
  YEAR,
  WEEK,
  DAY,
  ZERO
} = require('../constant-utils');


async function snapshot() {
  return network.provider.send('evm_snapshot', [])
}

async function restore(snapshotId) {
  return network.provider.send('evm_revert', [snapshotId])
}

async function now() {
  let now = (await ethers.provider.getBlock('latest')).timestamp;
  return now
}

async function moveForwardPeriods(days) {
  await ethers.provider.send("evm_increaseTime", [DAY.mul(days).toNumber()]);
  await ethers.provider.send("evm_mine");

  return true
}


describe("Index", function () {
  const initialMint = BigNumber.from("100000");

  const depositAmount = BigNumber.from("10000");
  const depositAmountLarge = BigNumber.from("40000");
  const withdrawAmount = BigNumber.from("10000");
  const defaultRate = BigNumber.from("1000000"); //initial rate between USDC and LP token
  const insureAmount = BigNumber.from("10000");
  const maxCost = BigNumber.from("10000");
  const targetLev = BigNumber.from("2000");;
  const allocPoint1 = BigNumber.from("2000");
  const allocPoint2 = BigNumber.from("3000");
  const upperSlack = BigNumber.from("900"); // 90%
  const lowerSlack = BigNumber.from("500"); // 50%

  const governanceFeeRate = BigNumber.from("100000"); //10%
  const MAGIC_SCALE_1E6 = BigNumber.from("1000000"); //1e6
  const RATE_DIVIDER = BigNumber.from("1000000"); //1e6
  const UTILIZATION_RATE_LENGTH_1E6 = BigNumber.from("1000000"); //1e6
  const padded1 = ethers.utils.hexZeroPad("0x1", 32);


  //market status tracker
  let m = {}

  //global status tracker
  let g = {
    totalBalance: ZERO,
    govBalance: ZERO,
  }

  //user balance tracker (this assumes there is only one market)
  let u = {}

  /** will be like below in the "before(async..." execution
   * 
   * u = {
   *    "balance": BigNumber,
   *    "deposited": BigNumber,
   *    "lp": BigNumber
   *  }
   */

  let v = {
    valueAll: ZERO,
    totalAttributions: ZERO,
    attributions: {
    },
  };

  const approveDeposit = async ({ token, target, depositor, amount }) => {
    await token.connect(depositor).approve(vault.address, amount);
    let tx = await target.connect(depositor).deposit(amount);

    if (m[target.address].type == "index") {
      let attributions;
      if (v.totalAttributions.isZero()) {
        attributions = amount;
      } else {
        attributions = amount.mul(v.totalAttributions).div(v.valueAll);
      }
      v.valueAll = v.valueAll.add(amount);
      v.totalAttributions = v.totalAttributions.add(attributions);
      v.attributions[target.address] = v.attributions[target.address].add(attributions);
      let mintAmount;
      if (m[target.address].totalSupply.gt(ZERO) && m[target.address].totalLiquidity.gt(ZERO)) {
        mintAmount = amount.mul(m[target.address].totalSupply).div(m[target.address].totalLiquidity);
      } else if (m[target.address].totalSupply.gt(ZERO) && m[target.address].totalLiquidity.isZero()) {
        mintAmount = amount.mul(m[target.address].totalSupply).div(amount);
      } else {
        mintAmount = amount;
      }

      u[`${depositor.address}`].balance = u[`${depositor.address}`].balance.sub(amount);
      u[`${depositor.address}`].deposited[`${target.address}`] = u[`${depositor.address}`].deposited[`${target.address}`].add(amount);
      u[`${depositor.address}`].lp[`${target.address}`] = u[`${depositor.address}`].lp[`${target.address}`].add(mintAmount);

      m[target.address].totalSupply = m[target.address].totalSupply.add(mintAmount);
      m[target.address].totalLiquidity = m[target.address].totalLiquidity.add(attributions); //ignored controller

      if (targetLev.sub(lowerSlack).gt(leverage())) {
        await adjustAlloc(m[index.address].totalLiquidity);
      }
    } else if (m[target.address].type == "pool") {
      //update user info => check
      let mintAmount = (await tx.wait()).events[2].args["mint"].toString();

      u[`${depositor.address}`].balance = u[`${depositor.address}`].balance.sub(amount);
      u[`${depositor.address}`].deposited[`${target.address}`] = u[`${depositor.address}`].deposited[`${target.address}`].add(amount);
      u[`${depositor.address}`].lp[`${target.address}`] = u[`${depositor.address}`].lp[`${target.address}`].add(mintAmount);

      expect(await token.balanceOf(depositor.address)).to.equal(u[`${depositor.address}`].balance);
      expect(await target.balanceOf(depositor.address)).to.equal(u[`${depositor.address}`].lp[`${target.address}`]);

      //2. update global and market status => check
      g.totalBalance = g.totalBalance.add(amount) //global balance of USDC increase

      let attributions;
      if (v.totalAttributions.isZero()) {
        attributions = amount;
      } else {
        attributions = amount.mul(v.totalAttributions).div(v.valueAll);
      }
      v.valueAll = v.valueAll.add(amount);
      v.totalAttributions = v.totalAttributions.add(attributions);
      v.attributions[target.address] = v.attributions[target.address].add(attributions);

      m[target.address].totalLP = m[target.address].totalLP.add(mintAmount); //market1 (Pool) total LP balance increase as much as newly minted LP token.
      m[target.address].depositAmount = m[target.address].depositAmount.add(amount); //USDC deposited
      m[target.address].marketBalance = m[target.address].marketBalance.add(amount); //USDC deposited

      if (!m[target.address].depositAmount.isZero()) {
        m[target.address].rate = defaultRate.mul(v.attributions[target.address].mul(v.valueAll).div(v.totalAttributions)).div(m[target.address].totalLP); //rate = (USDC balance in this contract) / (LP totalBalance)
      } else {
        m[target.address].rate = ZERO;
      }

      if (!m[target.address].insured.isZero()) {
        m[target.address].utilizationRate = UTILIZATION_RATE_LENGTH_1E6.mul(m[target.address].insured).div(m[target.address].marketBalance); //how much ratio is locked (=bought as insurance) among the pool.
      } else {
        m[target.address].utilizationRate = ZERO;
      }

      //sanity check
      await verifyPoolsStatus({
        pools: [
          {
            pool: target,
            totalLP: m[target.address].totalLP,
            totalLiquidity: m[target.address].marketBalance, //all deposited amount 
            availableBalance: m[target.address].marketBalance.sub(m[target.address].insured), //all amount - locked amount = available amount
            rate: m[target.address].rate,
            utilizationRate: m[target.address].utilizationRate,
            allInsuranceCount: m[target.address].allInsuranceCount
          }
        ]
      });

      await verifyDebtOf({
        vault: vault,
        target: target.address,
        debt: m[target.address].debt
      });

      //sanity check
      await verifyValueOfUnderlying({
        template: target,
        valueOfUnderlyingOf: depositor.address,
        valueOfUnderlying: u[`${depositor.address}`].lp[target.address].mul(m[target.address].rate).div(defaultRate)
      });

    } else if (m[target.address].type == "cds") {

    }
  }

  const withdraw = async ({ target, depositor, amount }) => {
    let tx = await target.connect(depositor).withdraw(amount);

    if (m[target.address].type == "index") {
      const _amount = m[target.address].totalLiquidity.mul(amount).div(m[target.address].totalSupply);

      u[`${depositor.address}`].balance = u[`${depositor.address}`].balance.add(_amount);
      u[`${depositor.address}`].deposited[`${target.address}`] = u[`${depositor.address}`].deposited[`${target.address}`].sub(amount);
      u[`${depositor.address}`].lp[`${target.address}`] = u[`${depositor.address}`].lp[`${target.address}`].sub(amount);

      m[target.address].totalSupply = m[target.address].totalSupply.sub(amount);
      const liquidityAfter = m[target.address].totalLiquidity.sub(_amount);
      if (liquidityAfter.gt(ZERO)) {
        const leverage = m[index.address].totalAllocatedCredit.mul(MAGIC_SCALE_1E6).div(liquidityAfter);
        if (targetLev.add(upperSlack).lt(leverage)) {
          await adjustAlloc(liquidityAfter);
        }
      } else {
        await adjustAlloc(ZERO);
      }

      const attributions = v.totalAttributions.mul(_amount).div(v.valueAll);
      v.totalAttributions = v.totalAttributions.sub(attributions);
      v.attributions[target.address] = v.attributions[target.address].sub(attributions);
      v.valueAll = v.valueAll.sub(_amount);
      m[target.address].totalLiquidity = liquidityAfter; //ignored controller
    } else if (m[target.address].type == "pool") {

    } else if (m[target.address].type == "cds") {

    }
  }

  const adjustAlloc = async (liquidity) => {
    const targetCredit = targetLev.mul(liquidity).div(MAGIC_SCALE_1E6);
    let poolList = [];
    let allocatable = targetCredit;
    let allocatablePoints = m[`${index.address}`].totalAllocPoint;
    let poolAddr, allocation, market, target, current, available, paused, delta;
    for (let i = 0; i < m[`${index.address}`].poolList.length; i++) {
      poolAddr = m[`${index.address}`].poolList[i];
      if (poolAddr !== ZERO_ADDRESS) {
        allocation = m[`${poolAddr}`].allocPoint;
        target = targetCredit.mul(allocation).div(allocatablePoints);
        market = markets.find(market => market.address === poolAddr);
        current = m[poolAddr].allocatedCredit;
        available = m[poolAddr].availableBalance;
        paused = await market.paused();
        if (current.gt(target) && current.sub(target).gt(available) || paused) {
          m[poolAddr].marketBalance = m[poolAddr].marketBalance.sub(available);
          m[poolAddr].allocatedCredit = m[poolAddr].allocatedCredit.sub(available);
          m[`${index.address}`].totalAllocatedCredit = m[`${index.address}`].totalAllocatedCredit.sub(available);
          allocatable = available.sub(current).add(available);
          allocatablePoints = allocatablePoints.sub(allocation);
          m[poolAddr].availableBalance = await market.availableBalance();
        } else {
          poolList.push({
            addr: poolAddr,
            current: current,
            available: available,
            allocation: allocation,
          });
        }
      }
    }

    for (let i = 0; i < poolList.length; i++) {
      poolAddr = poolList[i].addr;
      target = allocatable.mul(poolList[i].allocation).div(allocatablePoints);
      market = markets.find(market => market.address === poolAddr);
      current = poolList[i].current;
      available = poolList[i].available;
      if (current.gt(target) && !available.isZero()) {
        delta = current.sub(target);
        m[poolAddr].allocatedCredit = m[poolAddr].allocatedCredit.sub(delta);
        m[poolAddr].availableBalance = m[poolAddr].availableBalance.sub(delta);
        m[poolAddr].marketBalance = m[poolAddr].marketBalance.sub(delta);
        m[`${index.address}`].totalAllocatedCredit = m[`${index.address}`].totalAllocatedCredit.sub(delta);
      }
      if (current.lt(target)) {
        delta = target.sub(current);
        m[poolAddr].allocatedCredit = m[poolAddr].allocatedCredit.add(delta);
        m[poolAddr].availableBalance = m[poolAddr].availableBalance.add(delta);
        m[poolAddr].marketBalance = m[poolAddr].marketBalance.add(delta);
        m[`${index.address}`].totalAllocatedCredit = m[`${index.address}`].totalAllocatedCredit.add(delta);
      }
    }
  }

  const insure = async ({ pool, insurer, amount, maxCost, span, target }) => {
    await dai.connect(insurer).approve(vault.address, maxCost);
    let tx = await pool.connect(insurer).insure(amount, maxCost, span, target);

    let receipt = await tx.wait();
    let premium = receipt.events[2].args['premium'];

    let govFee = premium.mul(governanceFeeRate).div(RATE_DIVIDER);
    let fee = premium.sub(govFee);

    //update global and market status => check
    u[`${insurer.address}`].balance = u[`${insurer.address}`].balance.sub(premium);
    // expect(await dai.balanceOf(insurer.address)).to.equal(u[`${insurer.address}`].balance)



    //update global and market status => check
    m[pool.address].insured = m[pool.address].insured.add(amount);
    m[pool.address].marketBalance = m[pool.address].marketBalance.add(fee);
    g.govBalance = g.govBalance.add(govFee);
    g.totalBalance = g.totalBalance.add(premium);

    if (!m[pool.address].marketBalance.isZero()) {
      m[pool.address].utilizationRate = UTILIZATION_RATE_LENGTH_1E6.mul(m[pool.address].insured).div(m[pool.address].marketBalance);
    } else {
      m[pool.address].utilizationRate = ZERO;
    }

    if (!m[pool.address].depositAmount.isZero()) {
      // m[pool.address].rate = defaultRate.mul(m[pool.address].marketBalance).div(m[pool.address].totalLP);
      m[pool.address].rate = defaultRate.mul(v.attributions[pool.address].mul(v.valueAll).div(v.totalAttributions)).div(m[pool.address].totalLP);
    } else {
      m[pool.address].rate = ZERO;
    }

    m[pool.address].allInsuranceCount = m[pool.address].allInsuranceCount.add("1");

    await verifyPoolsStatus({
      pools: [
        {
          pool: pool,
          totalLP: m[pool.address].totalLP,
          totalLiquidity: m[pool.address].marketBalance,
          availableBalance: m[pool.address].marketBalance.sub(m[pool.address].insured),
          rate: m[pool.address].rate,
          utilizationRate: m[pool.address].utilizationRate,
          allInsuranceCount: m[pool.address].allInsuranceCount
        }
      ]
    });

    // await verifyDebtOf({
    //   vault: vault,
    //   target: pool.address,
    //   debt: m[pool.address].debt
    // })

    // await verifyVaultStatus({
    //   vault: vault,
    //   valueAll: g.totalBalance,
    //   totalAttributions: g.totalBalance,
    // })

    //return value
    return premium
  }

  const accuredPremiums = async () => {
    let ret = ZERO;
    let market, pendingPremium;
    for (let i = 0; i < m[`${index.address}`].poolList.length; i++) {
      market = markets.find(market => market.address === m[`${index.address}`].poolList[i]);
      pendingPremium = await market.pendingPremium(index.address);
      ret.add(pendingPremium);
    }

    return ret;
  }

  const withdrawable = async () => {
    if (m[`${index.address}`].totalLiquidity.gt(ZERO)) {
      let poolAddr, market, lowest, utilization;
      for (let i = 0; i < m[`${index.address}`].poolList.length; i++) {
        poolAddr = m[`${index.address}`].poolList[i];
        market = markets.find(market => market.address === poolAddr);
        if (m[poolAddr].allocPoint.gt(ZERO)) {
          utilization = await market.utilizationRate();
          if (i === 0) {
            lowest = utilization;
          }
          if (utilization.gt(lowest)) {
            lowest = utilization;
          }
        }
      }

      if (leverage().gt(targetLev)) {
        return ZERO;
      } else if (lowest == 0) {
        return m[`${index.address}`].totalLiquidity;
      } else {
        const accPremiums = await accuredPremiums();
        return UTILIZATION_RATE_LENGTH_1E6.sub(lowest)
          .mul(m[`${index.address}`].totalLiquidity)
          .mul(MAGIC_SCALE_1E6)
          .div(UTILIZATION_RATE_LENGTH_1E6)
          .div(leverage())
          .add(accPremiums);
      }
    } else {
      return 0;
    }
  }

  const leverage = () => {
    if (m[`${index.address}`].totalLiquidity > 0) {
      return m[`${index.address}`].totalAllocatedCredit.mul(MAGIC_SCALE_1E6).div(m[`${index.address}`].totalLiquidity);
    }

    return ZERO;
  }

  const rate = () => {
    if (m[`${index.address}`].totalLiquidity > 0) {
      return m[`${index.address}`].totalLiquidity.mul(MAGIC_SCALE_1E6).div(m[`${index.address}`].totalSupply);
    }

    return ZERO;
  }

  const approveDepositAndWithdrawRequest = async ({ token, target, depositor, amount }) => {
    await approveDeposit({ token, target, depositor, amount });
    await target.connect(depositor).requestWithdraw(amount);
  }

  const applyCover = async ({ pool, pending, payoutNumerator, payoutDenominator, incidentTimestamp }) => {

    const tree = await new MerkleTree(short, keccak256, {
      hashLeaves: true,
      sortPairs: true,
    });

    const root = await tree.getHexRoot();
    const leaf = keccak256(short[0]);
    const proof = await tree.getHexProof(leaf);

    await pool.applyCover(
      pending,
      payoutNumerator,
      payoutDenominator,
      incidentTimestamp,
      root,
      short,
      "metadata"
    );

    return proof
  }

  before('deploy & setup contracts', async () => {
    //import
    [creator, alice, bob, chad, tom, minter, gov] = await ethers.getSigners();

    const Ownership = await ethers.getContractFactory("Ownership");
    const DAI = await ethers.getContractFactory("TestERC20Mock");
    const PoolTemplate = await ethers.getContractFactory("PoolTemplate");
    const IndexTemplate = await ethers.getContractFactory("IndexTemplate");
    const CDSTemplate = await ethers.getContractFactory("CDSTemplate");
    const Factory = await ethers.getContractFactory("Factory");
    const Vault = await ethers.getContractFactory("Vault");
    const Registry = await ethers.getContractFactory("Registry");
    const PremiumModel = await ethers.getContractFactory("TestPremiumModel");
    const Parameters = await ethers.getContractFactory("Parameters");
    const Contorller = await ethers.getContractFactory("ControllerMock");

    //deploy
    ownership = await Ownership.deploy();
    dai = await DAI.deploy();
    registry = await Registry.deploy(ownership.address);
    factory = await Factory.deploy(registry.address, ownership.address);
    premium = await PremiumModel.deploy();
    controller = await Contorller.deploy(dai.address, ownership.address);
    vault = await Vault.deploy(
      dai.address,
      registry.address,
      controller.address,
      ownership.address
    );
    poolTemplate = await PoolTemplate.deploy();
    cdsTemplate = await CDSTemplate.deploy();
    indexTemplate = await IndexTemplate.deploy();
    parameters = await Parameters.deploy(ownership.address);

    await dai.mint(gov.address, initialMint);
    await dai.mint(chad.address, initialMint);
    await dai.mint(bob.address, initialMint);
    await dai.mint(alice.address, initialMint);

    await registry.setFactory(factory.address);

    await factory.approveTemplate(poolTemplate.address, true, false, true);
    await factory.approveTemplate(indexTemplate.address, true, false, true);
    await factory.approveTemplate(cdsTemplate.address, true, false, true);

    await factory.approveReference(poolTemplate.address, 0, dai.address, true);
    await factory.approveReference(poolTemplate.address, 1, dai.address, true);
    await factory.approveReference(
      poolTemplate.address,
      2,
      registry.address,
      true
    );
    await factory.approveReference(
      poolTemplate.address,
      3,
      parameters.address,
      true
    );
    await factory.approveReference(poolTemplate.address, 4, ZERO_ADDRESS, true); //everyone can be initialDepositor

    await factory.approveReference(
      indexTemplate.address,
      2,
      parameters.address,
      true
    );
    await factory.approveReference(indexTemplate.address, 0, dai.address, true);
    await factory.approveReference(
      indexTemplate.address,
      1,
      registry.address,
      true
    );

    await factory.approveReference(
      cdsTemplate.address,
      2,
      parameters.address,
      true
    );
    await factory.approveReference(cdsTemplate.address, 0, dai.address, true);
    await factory.approveReference(
      cdsTemplate.address,
      1,
      registry.address,
      true
    );


    await parameters.setFeeRate(ZERO_ADDRESS, governanceFeeRate);
    await parameters.setMaxList(ZERO_ADDRESS, "10");
    await parameters.setGrace(ZERO_ADDRESS, "259200");
    await parameters.setLockup(ZERO_ADDRESS, "604800");
    await parameters.setMindate(ZERO_ADDRESS, "604800");
    await parameters.setPremiumModel(ZERO_ADDRESS, premium.address);
    await parameters.setWithdrawable(ZERO_ADDRESS, "86400000");
    await parameters.setVault(dai.address, vault.address);

    await factory.createMarket(
      poolTemplate.address,
      "Here is metadata.",
      [0],
      [dai.address, dai.address, registry.address, parameters.address, gov.address]
    );
    await factory.createMarket(
      poolTemplate.address,
      "Here is metadata.",
      [0],
      [dai.address, dai.address, registry.address, parameters.address, gov.address]
    );
    const marketAddress1 = await factory.markets(0);
    const marketAddress2 = await factory.markets(1);
    market1 = await PoolTemplate.attach(marketAddress1);
    market2 = await PoolTemplate.attach(marketAddress2);

    await factory.createMarket(
      cdsTemplate.address,
      "Here is metadata.",
      [0],
      [dai.address, registry.address, parameters.address]
    );
    await factory.createMarket(
      indexTemplate.address,
      "Here is metadata.",
      [0],
      [dai.address, registry.address, parameters.address]
    );
    const marketAddress3 = await factory.markets(2);
    const marketAddress4 = await factory.markets(3);
    cds = await CDSTemplate.attach(marketAddress3);
    index = await IndexTemplate.attach(marketAddress4);

    await parameters.setUpperSlack(index.address, upperSlack);
    await parameters.setLowerSlack(index.address, lowerSlack);

    markets = [market1, market2, cds, index];

    m[`${market1.address}`] = {
      type: "pool",
      totalLP: ZERO,
      depositAmount: ZERO,
      marketBalance: ZERO,
      allocatedCredit: ZERO,
      allocPoint: ZERO,
      availableBalance: ZERO,
      insured: ZERO,
      rate: ZERO,
      utilizationRate: ZERO,
      allInsuranceCount: ZERO,
      debt: ZERO,
    };

    m[`${market2.address}`] = {
      type: "pool",
      totalLP: ZERO,
      depositAmount: ZERO,
      marketBalance: ZERO,
      allocatedCredit: ZERO,
      allocPoint: ZERO,
      availableBalance: ZERO,
      insured: ZERO,
      rate: ZERO,
      utilizationRate: ZERO,
      allInsuranceCount: ZERO,
      debt: ZERO,
    };

    m[`${cds.address}`] = {
      type: "cds",
      totalSupply: ZERO,
      totalLiquidity: ZERO,
      rate: ZERO
    };

    m[`${index.address}`] = {
      type: "index",
      totalSupply: ZERO,
      totalLiquidity: ZERO,
      totalAllocatedCredit: ZERO,
      totalAllocPoint: ZERO,
      withdrawable: ZERO,
      rate: ZERO,
      poolList: [],
      children: []
    };

    v = {
      valueAll: ZERO,
      totalAttributions: ZERO,
      attributions: {
        [market1.address]: ZERO,
        [market2.address]: ZERO,
        [index.address]: ZERO,
        [cds.address]: ZERO,
      },
    }

    accounts = [alice, bob, chad, tom];

    for (i = 0; i < accounts.length; i++) {
      u[`${accounts[i].address}`] = {
        "balance": initialMint,
        "deposited": {},
        "lp": {}
      }; //will mint for them later

      for (j = 0; j < markets.length; j++) {
        u[`${accounts[i].address}`].deposited[`${markets[j].address}`] = ZERO
        u[`${accounts[i].address}`].lp[`${markets[j].address}`] = ZERO
      }
    }
    console.log(u[`${alice.address}`]);

    await registry.setCDS(ZERO_ADDRESS, cds.address);

    await index.set("0", market1.address, allocPoint1);
    m[`${index.address}`].poolList.push(market1.address);
    m[`${market1.address}`].allocPoint = allocPoint1;
    m[`${index.address}`].totalAllocPoint = m[`${index.address}`].totalAllocPoint.add(allocPoint1);
    await adjustAlloc(m[index.address].totalLiquidity);
    await index.set("1", market2.address, allocPoint2);
    m[`${index.address}`].poolList.push(market2.address);
    m[`${market2.address}`].allocPoint = allocPoint2;
    m[`${index.address}`].totalAllocPoint = m[`${index.address}`].totalAllocPoint.add(allocPoint2);
    await adjustAlloc(m[index.address].totalLiquidity);
    await index.setLeverage(targetLev);
  })

  beforeEach(async () => {
    snapshotId = await snapshot();
  });

  afterEach(async () => {
    await restore(snapshotId);

    for (i = 0; i < accounts.length; i++) {
      u[`${accounts[i].address}`] = {
        "balance": initialMint,
        "deposited": {},
        "lp": {}
      }; //will mint for them later

      for (j = 0; j < markets.length; j++) {
        u[`${accounts[i].address}`].deposited[`${markets[j].address}`] = ZERO
        u[`${accounts[i].address}`].lp[`${markets[j].address}`] = ZERO
      }
    }

    for (i = 0; i < markets.length; i++) {
      switch (m[`${markets[i].address}`].type) {
        case 'index':
          m[`${markets[i].address}`] = {
            ...m[`${markets[i].address}`],
            totalSupply: ZERO,
            totalLiquidity: ZERO,
            totalAllocatedCredit: ZERO,
            children: []
          };
          break;

        case 'pool':
          m[`${markets[i].address}`] = {
            ...m[`${markets[i].address}`],
            totalLP: ZERO,
            depositAmount: ZERO,
            marketBalance: ZERO,
            allocatedCredit: ZERO,
            availableBalance: ZERO,
            insured: ZERO,
            rate: ZERO,
            utilizationRate: ZERO,
            allInsuranceCount: ZERO
          };
          break;

        case 'cds':
          break;
      }
    }

    v = {
      valueAll: ZERO,
      totalAttributions: ZERO,
      attributions: {
        [market1.address]: ZERO,
        [market2.address]: ZERO,
        [index.address]: ZERO,
        [cds.address]: ZERO,
      },
    };
  })

  describe("Condition", function () {
    it("Should contracts be deployed", async () => {
      expect(dai.address).to.exist;
      expect(factory.address).to.exist;
      expect(parameters.address).to.exist;
      expect(vault.address).to.exist;
      expect(market1.address).to.exist;
      expect(market2.address).to.exist;
      expect(index.address).to.exist;
      expect(cds.address).to.exist;
      expect(await index.totalAllocPoint()).to.equal(m[`${index.address}`].totalAllocPoint);
      expect(await index.targetLev()).to.equal(targetLev);
    });
  });

  describe.skip("deposit", function () {
    beforeEach(async () => {
    });

    it("deposit success", async function () {
      await approveDeposit({
        token: dai,
        target: index,
        depositor: alice,
        amount: depositAmount
      });

      //CHECK ALL STATUS
      //index
      const withdrwable = await withdrawable();
      await verifyIndexStatus({
        index: index,
        totalSupply: m[index.address].totalSupply, //LP token
        totalLiquidity: m[index.address].totalLiquidity, //underwriting asset
        totalAllocatedCredit: m[index.address].totalAllocatedCredit, //totalLiquidity * (leverage/1000000)
        leverage: leverage(),
        withdrawable: withdrwable, //un-utilized underwriting asset
        rate: rate(),
      });

      // pool
      await verifyPoolsStatus_legacy({
        pools: [
          {
            pool: market1,
            totalLiquidity: m[market1.address].marketBalance,
            availableBalance: m[market1.address].availableBalance
          },
          {
            pool: market2,
            totalLiquidity: m[market2.address].marketBalance,
            availableBalance: m[market2.address].availableBalance
          }
        ]
      });

      await verifyPoolsStatusForIndex_legacy({
        pools: [
          {
            pool: market1,
            allocatedCreditOf: index.address,
            allocatedCredit: m[market1.address].allocatedCredit,
          },
          {
            pool: market2,
            allocatedCreditOf: index.address,
            allocatedCredit: m[market2.address].allocatedCredit,
          }
        ]
      });

      // //vault
      await verifyVaultStatus({
        vault: vault,
        valueAll: v.valueAll,
        totalAttributions: v.totalAttributions,
      });

      await verifyVaultStatusOf({
        vault: vault,
        target: index.address,
        attributions: v.totalAttributions,
        underlyingValue: v.valueAll.mul(v.attributions[index.address]).div(v.totalAttributions) // v.valueAll.mul(v.totalAttributions).div(v.totalAttributions)
      });
    });


    it("revert when paused", async function () {
      await index.setPaused(true);

      await expect(index.connect(alice).deposit(depositAmount)).to.revertedWith(
        "ERROR: DEPOSIT_DISABLED"
      );
    });

    it("revert when locked", async function () {
    });

    it("revert when amount is 0", async function () {
    });
  })

  describe("withdraw", function () {
    beforeEach(async () => {
      //deposit and withdraw request
      await approveDepositAndWithdrawRequest({
        token: dai,
        target: index,
        depositor: alice,
        amount: depositAmount
      })

      //CHECK ALL STATUS
      //index
      const withdrwable = await withdrawable();
      await verifyIndexStatus({
        index: index,
        totalSupply: m[index.address].totalSupply, //LP token
        totalLiquidity: m[index.address].totalLiquidity, //underwriting asset
        totalAllocatedCredit: m[index.address].totalAllocatedCredit, //totalLiquidity * (leverage/1000000)
        leverage: leverage(),
        withdrawable: withdrwable, //un-utilized underwriting asset
        rate: rate(),
      })

      //pool
      await verifyPoolsStatus_legacy({
        pools: [
          {
            pool: market1,
            totalLiquidity: m[market1.address].marketBalance,
            availableBalance: m[market1.address].availableBalance,
          },
          {
            pool: market2,
            totalLiquidity: m[market2.address].marketBalance,
            availableBalance: m[market2.address].availableBalance,
          }
        ]
      });

      await verifyPoolsStatusForIndex_legacy({
        pools: [
          {
            pool: market1,
            allocatedCreditOf: index.address,
            allocatedCredit: m[market1.address].allocatedCredit,
          },
          {
            pool: market2,
            allocatedCreditOf: index.address,
            allocatedCredit: m[market2.address].allocatedCredit,
          }
        ]
      });

      //vault
      await verifyVaultStatus({
        vault: vault,
        valueAll: v.valueAll,
        totalAttributions: v.totalAttributions,
      });

      await verifyVaultStatusOf({
        vault: vault,
        target: index.address,
        attributions: v.totalAttributions,
        underlyingValue: v.valueAll.mul(v.attributions[index.address]).div(v.totalAttributions) // v.valueAll.mul(v.totalAttributions).div(v.totalAttributions)
      });
    });

    it("success withdraw", async function () {
      await moveForwardPeriods(8);
      await withdraw({
        target: index,
        depositor: alice,
        amount: withdrawAmount
      });

      //CHECK ALL STATUS
      //index
      const withrawble = await withdrawable();
      await verifyIndexStatus({
        index: index,
        totalSupply: m[index.address].totalSupply,
        totalLiquidity: m[index.address].totalLiquidity,
        totalAllocatedCredit: m[index.address].totalAllocatedCredit,
        leverage: leverage(), //become 0 too
        withdrawable: withrawble,
        rate: rate(),
      });

      // //pool
      await verifyPoolsStatus_legacy({
        pools: [
          {
            pool: market1,
            totalLiquidity: m[market1.address].marketBalance,
            availableBalance: m[market1.address].availableBalance,
          },
          {
            pool: market2,
            totalLiquidity: m[market2.address].marketBalance,
            availableBalance: m[market2.address].availableBalance,
          }
        ]
      });

      await verifyPoolsStatusForIndex_legacy({
        pools: [
          {
            pool: market1,
            allocatedCreditOf: index.address,
            allocatedCredit: m[market1.address].allocatedCredit,
          },
          {
            pool: market2,
            allocatedCreditOf: index.address,
            allocatedCredit: m[market2.address].allocatedCredit,
          }
        ]
      });

      //vault
      await verifyVaultStatus({
        vault: vault,
        valueAll: v.valueAll,
        totalAttributions: v.totalAttributions,
      });

      await verifyVaultStatusOf({
        vault: vault,
        target: index.address,
        attributions: v.attributions[index.address],
        underlyingValue: v.attributions[index.address].isZero() ? "0" : v.valueAll.mul(v.attributions[index.address]).div(v.totalAttributions) // v.valueAll.mul(v.totalAttributions).div(v.totalAttributions)
      });
    });

    it("success when paused", async function () {

      await index.setPaused(true);

      await expect(index.connect(alice).deposit(depositAmount)).to.revertedWith(
        "ERROR: DEPOSIT_DISABLED"
      );

      await moveForwardPeriods(8);

      await withdraw({
        target: index,
        depositor: alice,
        amount: withdrawAmount
      });

      await verifyBalance({
        token: dai,
        address: alice.address,
        expectedBalance: u[alice.address].balance,
      })
    });

    it("revert WITHDRAWAL_PENDING", async function () {
    });

    it("revert when until lockup period ends", async function () {

      await expect(index.connect(alice).withdraw(withdrawAmount)).to.revertedWith(
        "ERROR: WITHDRAWAL_QUEUE"
      );
    });

    it("revert WITHDRAWAL_NO_ACTIVE_REQUEST", async function () {
    });

    it("revert when amount is more than request", async function () {

      await moveForwardPeriods(8);

      await expect(index.connect(alice).withdraw(withdrawAmount.add("1"))).to.revertedWith(
        "ERROR: WITHDRAWAL_EXCEEDED_REQUEST"
      );
    });

    it("revert withdraw zero balance", async function () {

      await moveForwardPeriods(8);
      await expect(index.connect(alice).withdraw(ZERO)).to.revertedWith(
        "ERROR: WITHDRAWAL_ZERO"
      );
    });

    it("revert withdraw when liquidity is locked for insurance", async function () {
      await approveDepositAndWithdrawRequest({
        token: dai,
        target: market1,
        depositor: alice,
        amount: depositAmount
      });

      await dai.connect(bob).approve(vault.address, insureAmount);

      const premium = await insure({
        pool: market1,
        insurer: bob,
        amount: insureAmount,
        maxCost: insureAmount,
        span: WEEK,
        target: padded1
      })


      // let expectPremium = BigNumber.from("10000").div("10"); //amount * premium rate

      // expect(premium).to.equal(expectPremium);

      // expect(await market1.utilizationRate()).to.equal(m[market1.address].utilizationRate);
      // expect(await market2.utilizationRate()).to.equal(m[market2.address].utilizationRate);

      // await verifyBalance({
      //   token: dai,
      //   address: bob.address,
      //   expectedBalance: u[bob.address].balance,
      // });

      // await verifyBalance({
      //   token: dai,
      //   address: vault.address,
      //   expectedBalance: v.valueAll,
      // });


      // //after insure(), index gains premium, but aloc doesn't change. this leads to lower the leverage
      // await verifyIndexStatus({
      //   index: index,
      //   totalSupply: 10000,
      //   totalLiquidity: 10950,
      //   totalAllocatedCredit: 20000,
      //   leverage: 1826,
      //   withdrawable: 950,
      //   rate: "1095000000000000000"
      // })

      // await moveForwardPeriods(8);

      // await expect(index.connect(alice).withdraw("951")).to.revertedWith(
      //   "ERROR: WITHDRAW_INSUFFICIENT_LIQUIDITY"
      // );
    });
  });

  describe.skip("else", function () {
    beforeEach(async () => {
    });

    it("accrues premium after deposit", async function () {
      await approveDepositAndWithdrawRequest({
        token: dai,
        target: index,
        depositor: alice,
        amount: 10000
      })

      await verifyIndexStatus({
        index: index,
        totalSupply: 10000,
        totalLiquidity: 10000,
        totalAllocatedCredit: 20000,
        leverage: 2000,
        withdrawable: 10000,
        rate: "1000000000000000000"
      })

      await dai.connect(bob).approve(vault.address, 20000);

      expect(await index.rate()).to.equal("1000000000000000000");

      await insure({
        pool: market1,
        insurer: bob,
        amount: 10000,
        maxCost: 10000,
        span: YEAR,
        target: '0x4e69636b00000000000000000000000000000000000000000000000000000000'
      })

      await verifyBalance({
        token: dai,
        address: bob.address,
        expectedBalance: 99000
      })

      await verifyIndexStatus({
        index: index,
        totalSupply: 10000,
        totalLiquidity: 10950,
        totalAllocatedCredit: 20000,
        leverage: 1826,
        withdrawable: 950,
        rate: "1095000000000000000"
      })

      expect(await market1.pendingPremium(index.address)).to.equal("950"); //verify


      //withdrawal also harvest accrued premium
      await moveForwardPeriods(369);

      await market1.unlock("0");

      await verifyBalance({
        token: dai,
        address: alice.address,
        expectedBalance: 90000
      })

      await index.connect(alice).withdraw("10000");

      //Harvested premium is reflected on their account balance
      await verifyBalance({
        token: dai,
        address: alice.address,
        expectedBalance: 100950
      })
    });

    it("also transfers lockup period when iToken is transferred", async function () {
      await approveDepositAndWithdrawRequest({
        token: dai,
        target: index,
        depositor: alice,
        amount: 10000
      })

      await verifyIndexStatus({
        index: index,
        totalSupply: 10000,
        totalLiquidity: 10000,
        totalAllocatedCredit: 20000,
        leverage: 2000,
        withdrawable: 10000,
        rate: "1000000000000000000"
      })

      //Transferring iToken, which also distribute premium
      await index.connect(alice).transfer(tom.address, "10000");
      await index.connect(tom).requestWithdraw("10000");

      await expect(index.connect(alice).withdraw("10000")).to.revertedWith(
        "ERROR: WITHDRAWAL_QUEUE"
      );
      await expect(index.connect(tom).withdraw("10000")).to.revertedWith(
        "ERROR: WITHDRAWAL_QUEUE"
      );

      await moveForwardPeriods(8);

      await expect(index.connect(alice).withdraw("10000")).to.revertedWith(
        "ERROR: WITHDRAWAL_EXCEEDED_REQUEST"
      );
      await index.connect(tom).withdraw("10000");

      await verifyBalance({
        token: dai,
        address: tom.address,
        expectedBalance: 10000
      })
    });

    it("DISABLE deposit when paused(withdrawal is possible)", async function () {

      await approveDepositAndWithdrawRequest({
        token: dai,
        target: index,
        depositor: alice,
        amount: 10000
      })

      await verifyIndexStatus({
        index: index,
        totalSupply: 10000,
        totalLiquidity: 10000,
        totalAllocatedCredit: 20000,
        leverage: 2000,
        withdrawable: 10000,
        rate: "1000000000000000000"
      })

      await index.setPaused(true);

      await expect(index.connect(alice).deposit("10000")).to.revertedWith(
        "ERROR: DEPOSIT_DISABLED"
      );

      await moveForwardPeriods(8);

      await index.connect(alice).withdraw("10000");

      await verifyBalance({
        token: dai,
        address: alice.address,
        expectedBalance: 100000
      })

    });

    it("DISABLE deposit and withdrawal when reporting or payingout", async function () {
      //Can deposit and withdraw in normal time
      await approveDepositAndWithdrawRequest({
        token: dai,
        target: index,
        depositor: alice,
        amount: 10000
      })

      await verifyIndexStatus({
        index: index,
        totalSupply: 10000,
        totalLiquidity: 10000,
        totalAllocatedCredit: 20000,
        leverage: 2000,
        withdrawable: 10000,
        rate: "1000000000000000000"
      })

      await moveForwardPeriods(8);

      let incident = await now();

      await applyCover({
        pool: market1,
        pending: 604800,
        payoutNumerator: 5000,
        payoutDenominator: 10000,
        incidentTimestamp: incident
      })

      await expect(index.connect(alice).deposit("10000")).to.revertedWith(
        "ERROR: DEPOSIT_DISABLED"
      );
      await expect(index.connect(alice).withdraw("10000")).to.revertedWith(
        "ERROR: WITHDRAWAL_PENDING"
      );

      await moveForwardPeriods(11);

      await market1.resume();
      await index.resume();

      await verifyIndexStatus({
        index: index,
        totalSupply: 10000,
        totalLiquidity: 10000,
        totalAllocatedCredit: 20000,
        leverage: 2000,
        withdrawable: 10000,
        rate: "1000000000000000000"
      })

      await index.connect(alice).withdraw("10000");
      await verifyBalance({
        token: dai,
        address: alice.address,
        expectedBalance: 100000
      })
    });

    it("devaluate underlying when cover claim is accepted", async function () {
      await approveDepositAndWithdrawRequest({
        token: dai,
        target: index,
        depositor: alice,
        amount: 10000
      })

      await verifyIndexStatus({
        index: index,
        totalSupply: 10000,
        totalLiquidity: 10000,
        totalAllocatedCredit: 20000,
        leverage: 2000,
        withdrawable: 10000,
        rate: "1000000000000000000"
      })

      await verifyPoolsStatus_legacy({
        pools: [
          {
            pool: market1,
            totalLiquidity: 10000,
            availableBalance: 10000
          },
          {
            pool: market2,
            totalLiquidity: 10000,
            availableBalance: 10000
          }
        ]
      })

      await verifyPoolsStatusOf({
        pools: [
          {
            pool: market1,
            allocatedCreditOf: index.address,
            allocatedCredit: 10000,
          },
          {
            pool: market2,
            allocatedCreditOf: index.address,
            allocatedCredit: 10000,
          }
        ]
      })

      await dai.connect(bob).approve(vault.address, 10000);
      let receipt = await insure({
        pool: market1,
        insurer: bob,
        amount: 10000,
        maxCost: 10000,
        span: 86400 * 8,
        target: '0x4e69636b00000000000000000000000000000000000000000000000000000000'
      })

      let premiumRate = 100000 //10%
      let divider = 1000000

      let premium = receipt.events[4].args[6]
      let expectPremium = BigNumber.from("10000").mul(premiumRate).div(divider); //amount * premium rate
      expect(premium).to.equal(expectPremium);


      expect(await dai.balanceOf(bob.address)).to.equal("99000");

      let incident = await now()

      let proof = await applyCover({
        pool: market1,
        pending: 604800,
        payoutNumerator: 5000,
        payoutDenominator: 10000,
        incidentTimestamp: incident
      })

      await verifyVaultStatus({
        vault: vault,
        valueAll: 11000,
        totalAttributions: 11000,
      })

      await verifyVaultStatusOf({
        vault: vault,
        target: creator.address,
        attributions: 50,
        underlyingValue: 50
      })


      await verifyVaultStatusOf({
        vault: vault,
        target: market1.address,
        attributions: 950,
        underlyingValue: 950
      })

      await verifyVaultStatusOf({
        vault: vault,
        target: index.address,
        attributions: 10000,
        underlyingValue: 10000
      })



      expect(await market1.totalLiquidity()).to.closeTo("10000", "1");

      await market1.connect(bob).redeem("0", proof);

      await expect(market1.connect(alice).unlock("0")).to.revertedWith(
        "ERROR: UNLOCK_BAD_COINDITIONS"
      );

      await verifyIndexStatus({
        index: index,
        totalSupply: 10000,
        totalLiquidity: 5950,
        totalAllocatedCredit: 11900,
        leverage: 2000,
        withdrawable: 5950,
        rate: "595000000000000000"
      })

      await verifyVaultStatus({
        vault: vault,
        target: index.address,
        attributions: 5054,
        valueAll: 6000,
        totalAttributions: 6000,
        underlyingValue: 5054
      })

      await verifyPoolsStatus_legacy({
        pools: [
          {
            pool: market1,
            totalLiquidity: 5950,
            availableBalance: 5950
          },
          {
            pool: market2,
            totalLiquidity: 5950,
            availableBalance: 5950
          }
        ]
      })

      await verifyPoolsStatusOf({
        pools: [
          {
            pool: market1,
            allocatedCreditOf: index.address,
            allocatedCredit: 5950,
          },
          {
            pool: market2,
            allocatedCreditOf: index.address,
            allocatedCredit: 5950,
          }
        ]
      })

      await moveForwardPeriods(11);
      await market1.resume();
      await index.resume();

      await index.connect(alice).withdraw("10000");

      await verifyBalances({
        token: dai,
        userBalances: {
          [alice.address]: 95950,
          [bob.address]: 104000
        }
      })

      //Simulation: full payout
      await approveDepositAndWithdrawRequest({
        token: dai,
        target: index,
        depositor: alice,
        amount: 10000
      })

      await verifyIndexStatus({
        index: index,
        totalSupply: 10000,
        totalLiquidity: 10000,
        totalAllocatedCredit: 20000,
        leverage: 2000,
        withdrawable: 10000,
        rate: "1000000000000000000"
      })

      currentTimestamp = BigNumber.from(
        (await ethers.provider.getBlock("latest")).timestamp
      );

      await insure({
        pool: market1,
        insurer: bob,
        amount: 10000,
        maxCost: 10000,
        span: 86400 * 8,
        target: '0x4e69636b00000000000000000000000000000000000000000000000000000000'
      })

      incident = await now();

      proof = await applyCover({
        pool: market1,
        pending: 604800,
        payoutNumerator: 10000,
        payoutDenominator: 10000,
        incidentTimestamp: incident
      })

      await market1.connect(bob).redeem("1", proof);

      await verifyIndexStatus({
        index: index,
        totalSupply: 10000,
        totalLiquidity: 950,
        totalAllocatedCredit: 1900,
        leverage: 2000,
        withdrawable: 950,
        rate: "95000000000000000"
      })
      expect(await index.valueOfUnderlying(alice.address)).to.equal("950");

      await moveForwardPeriods(11);

      await market1.resume();
      await index.resume();

      await index.connect(alice).withdraw("10000");

      await verifyBalances({
        token: dai,
        userBalances: {
          [alice.address]: 86900,
          [bob.address]: 113000
        }
      })
    });

  })

  describe.skip("Index parameter configurations (case un-equal allocation)", function () {
    beforeEach(async () => {
      //Deploy a new pool
      const PoolTemplate = await ethers.getContractFactory("PoolTemplate");
      await factory.createMarket(
        poolTemplate.address,
        "Here is metadata.",
        [1, 0],
        [dai.address, dai.address, registry.address, parameters.address]
      );
      const marketAddress5 = await factory.markets(4);
      market3 = await PoolTemplate.attach(marketAddress5);
    });

    it("allows new pool addition", async function () {
      await approveDeposit({
        token: dai,
        target: index,
        depositor: alice,
        amount: 10000
      })

      //Case1: Add when no liquidity is locked
      //Expected results: Reallocaet liquidity market1: 5000, market2: 5000, market3: 10000
      await index.set("2", market3.address, "2000");

      await verifyIndexStatus({
        index: index,
        totalSupply: 10000,
        totalLiquidity: 10000,
        totalAllocatedCredit: 20000,
        leverage: 2000,
        withdrawable: 10000,
        rate: "1000000000000000000"
      })

      await verifyVaultStatus({
        vault: vault,
        valueAll: 10000,
        totalAttributions: 10000
      })

      await verifyVaultStatusOf({
        vault: vault,
        target: index.address,
        attributions: 10000,
        underlyingValue: 10000
      })


      await verifyPoolsStatus_legacy({
        pools: [
          {
            pool: market1,
            totalLiquidity: 5000,
            availableBalance: 5000
          },
          {
            pool: market2,
            totalLiquidity: 5000,
            availableBalance: 5000
          },
          {
            pool: market3,
            totalLiquidity: 10000,
            availableBalance: 10000
          }
        ]
      })

      await verifyPoolsStatusOf({
        pools: [
          {
            pool: market1,
            allocatedCreditOf: index.address,
            allocatedCredit: 5000,
          },
          {
            pool: market2,
            allocatedCreditOf: index.address,
            allocatedCredit: 5000,
          },
          {
            pool: market3,
            allocatedCreditOf: index.address,
            allocatedCredit: 10000,
          }
        ]
      })


      await index.set("2", market3.address, "0");

      //Case2: Add when liquidity is locked(market1 has locked 50% of index liquidity ) d
      await verifyIndexStatus({
        index: index,
        totalSupply: 10000,
        totalLiquidity: 10000,
        totalAllocatedCredit: 20000,
        leverage: 2000,
        withdrawable: 10000,
        rate: "1000000000000000000"
      })
      await verifyPoolsStatus_legacy({
        pools: [
          {
            pool: market1,
            totalLiquidity: 10000,
            availableBalance: 10000
          },
          {
            pool: market2,
            totalLiquidity: 10000,
            availableBalance: 10000
          },
          {
            pool: market3,
            totalLiquidity: 0,
            availableBalance: 0
          }
        ]
      })

      await verifyPoolsStatusOf({
        pools: [
          {
            pool: market1,
            allocatedCreditOf: index.address,
            allocatedCredit: 10000,
          },
          {
            pool: market2,
            allocatedCreditOf: index.address,
            allocatedCredit: 10000,
          },
          {
            pool: market3,
            allocatedCreditOf: index.address,
            allocatedCredit: 0,
          }
        ]
      })

      await dai.connect(bob).approve(vault.address, 10000);
      await insure({
        pool: market1,
        insurer: bob,
        amount: 10000,
        maxCost: 10000,
        span: 86400 * 10,
        target: '0x4e69636b00000000000000000000000000000000000000000000000000000000'
      })

      expect(await market1.totalLiquidity()).to.equal("10000");
      expect(await market1.availableBalance()).to.equal("0");

      await verifyIndexStatus({
        index: index,
        totalSupply: 10000,
        totalLiquidity: 10950,
        totalAllocatedCredit: 20000,
        leverage: 1826,
        withdrawable: 950,
        rate: "1095000000000000000"
      })

      await index.set("2", market3.address, "2000");

      await verifyIndexStatus({
        index: index,
        totalSupply: 10000,
        totalLiquidity: 10950,
        totalAllocatedCredit: 21899,
        leverage: 1999,
        withdrawable: 0,
        rate: "1095000000000000000"
      })
      await verifyPoolsStatus_legacy({
        pools: [
          {
            pool: market1,
            totalLiquidity: 10000,
            availableBalance: 0
          },
          {
            pool: market2,
            totalLiquidity: 3966,
            availableBalance: 3966
          },
          {
            pool: market3,
            totalLiquidity: 7933,
            availableBalance: 7933
          }
        ]
      })

      await verifyPoolsStatusOf({
        pools: [
          {
            pool: market1,
            allocatedCreditOf: index.address,
            allocatedCredit: 10000,
          },
          {
            pool: market2,
            allocatedCreditOf: index.address,
            allocatedCredit: 3966,
          },
          {
            pool: market3,
            allocatedCreditOf: index.address,
            allocatedCredit: 7933,
          }
        ]
      })
    });

    it("allows pool removal", async function () {
      await index.set("2", market3.address, "1000");

      await approveDeposit({
        token: dai,
        target: index,
        depositor: alice,
        amount: 10000
      })

      //before remomval
      await verifyIndexStatus({
        index: index,
        totalSupply: 10000,
        totalLiquidity: 10000,
        totalAllocatedCredit: 19998,
        leverage: 1999,
        withdrawable: 10000,
        rate: "1000000000000000000"
      })

      await verifyVaultStatus({
        vault: vault,
        valueAll: 10000,
        totalAttributions: 10000,
      })

      await verifyVaultStatusOf({
        vault: vault,
        target: index.address,
        attributions: 10000,
        underlyingValue: 10000
      })

      await verifyPoolsStatus_legacy({
        pools: [
          {
            pool: market1,
            totalLiquidity: 6666,
            availableBalance: 6666
          },
          {
            pool: market2,
            totalLiquidity: 6666,
            availableBalance: 6666
          },
          {
            pool: market3,
            totalLiquidity: 6666,
            availableBalance: 6666
          }
        ]
      })

      await verifyPoolsStatusOf({
        pools: [
          {
            pool: market1,
            allocatedCreditOf: index.address,
            allocatedCredit: 6666,
          },
          {
            pool: market2,
            allocatedCreditOf: index.address,
            allocatedCredit: 6666,
          },
          {
            pool: market3,
            allocatedCreditOf: index.address,
            allocatedCredit: 6666,
          }
        ]
      })


      //after remomval
      await index.set("2", market3.address, "0");

      await verifyIndexStatus({
        index: index,
        totalSupply: 10000,
        totalLiquidity: 10000,
        totalAllocatedCredit: 20000,
        leverage: 2000,
        withdrawable: 10000,
        rate: "1000000000000000000"
      })

      await verifyVaultStatus({
        vault: vault,
        valueAll: 10000,
        totalAttributions: 10000,
      })

      await verifyVaultStatusOf({
        vault: vault,
        target: index.address,
        attributions: 10000,
        underlyingValue: 10000
      })

      await verifyPoolsStatus_legacy({
        pools: [
          {
            pool: market1,
            totalLiquidity: 10000,
            availableBalance: 10000
          },
          {
            pool: market2,
            totalLiquidity: 10000,
            availableBalance: 10000
          },
          {
            pool: market3,
            totalLiquidity: 0,
            availableBalance: 0
          }
        ]
      })

      await verifyPoolsStatusOf({
        pools: [
          {
            pool: market1,
            allocatedCreditOf: index.address,
            allocatedCredit: 10000,
          },
          {
            pool: market2,
            allocatedCreditOf: index.address,
            allocatedCredit: 10000,
          },
          {
            pool: market3,
            allocatedCreditOf: index.address,
            allocatedCredit: 0,
          }
        ]
      })
    });


    it("mimics pool removal if the pool is paused", async function () {
      await index.set("2", market3.address, "1000");

      await approveDeposit({
        token: dai,
        target: index,
        depositor: alice,
        amount: 10000
      })

      //before remomval

      await verifyIndexStatus({
        index: index,
        totalSupply: 10000,
        totalLiquidity: 10000,
        totalAllocatedCredit: 19998,
        leverage: 1999,
        withdrawable: 10000,
        rate: "1000000000000000000"
      })

      await verifyVaultStatus({
        vault: vault,
        valueAll: 10000,
        totalAttributions: 10000,
      })

      await verifyVaultStatusOf({
        vault: vault,
        target: index.address,
        attributions: 10000,
        underlyingValue: 10000
      })

      await verifyPoolsStatus_legacy({
        pools: [
          {
            pool: market1,
            totalLiquidity: 6666,
            availableBalance: 6666
          },
          {
            pool: market2,
            totalLiquidity: 6666,
            availableBalance: 6666
          },
          {
            pool: market3,
            totalLiquidity: 6666,
            availableBalance: 6666
          }
        ]
      })

      await verifyPoolsStatusOf({
        pools: [
          {
            pool: market1,
            allocatedCreditOf: index.address,
            allocatedCredit: 6666,
          },
          {
            pool: market2,
            allocatedCreditOf: index.address,
            allocatedCredit: 6666,
          },
          {
            pool: market3,
            allocatedCreditOf: index.address,
            allocatedCredit: 6666,
          }
        ]
      })

      //after remomval
      await market3.setPaused(true);
      await index.adjustAlloc();

      expect(await market1.allocatedCredit(index.address)).to.equal("10000");

      await verifyIndexStatus({
        index: index,
        totalSupply: 10000,
        totalLiquidity: 10000,
        totalAllocatedCredit: 20000,
        leverage: 2000,
        withdrawable: 10000,
        rate: "1000000000000000000"
      })

      await verifyVaultStatus({
        vault: vault,
        valueAll: 10000,
        totalAttributions: 10000,
      })

      await verifyVaultStatusOf({
        vault: vault,
        target: index.address,
        attributions: 10000,
        underlyingValue: 10000
      })

      await verifyPoolsStatus_legacy({
        pools: [
          {
            pool: market1,
            totalLiquidity: 10000,
            availableBalance: 10000
          },
          {
            pool: market2,
            totalLiquidity: 10000,
            availableBalance: 10000
          },
          {
            pool: market3,
            totalLiquidity: 0,
            availableBalance: 0
          }
        ]
      })

      await verifyPoolsStatusOf({
        pools: [
          {
            pool: market1,
            allocatedCreditOf: index.address,
            allocatedCredit: 10000,
          },
          {
            pool: market2,
            allocatedCreditOf: index.address,
            allocatedCredit: 10000,
          },
          {
            pool: market3,
            allocatedCreditOf: index.address,
            allocatedCredit: 0,
          }
        ]
      })
    });

    it("allows leverage rate increment", async function () {
      await index.set("2", market3.address, "1000");

      await approveDeposit({
        token: dai,
        target: index,
        depositor: alice,
        amount: 10000
      })

      //lev 2.0
      await verifyIndexStatus({
        index: index,
        totalSupply: 10000,
        totalLiquidity: 10000,
        totalAllocatedCredit: 19998,
        leverage: 1999,
        withdrawable: 10000,
        rate: "1000000000000000000"
      })

      await verifyVaultStatus({
        vault: vault,
        valueAll: 10000,
        totalAttributions: 10000,
      })

      await verifyVaultStatusOf({
        vault: vault,
        target: index.address,
        attributions: 10000,
        underlyingValue: 10000
      })

      await verifyPoolsStatus_legacy({
        pools: [
          {
            pool: market1,
            totalLiquidity: 6666,
            availableBalance: 6666
          },
          {
            pool: market2,
            totalLiquidity: 6666,
            availableBalance: 6666
          },
          {
            pool: market3,
            totalLiquidity: 6666,
            availableBalance: 6666
          }
        ]
      })

      await verifyPoolsStatusOf({
        pools: [
          {
            pool: market1,
            allocatedCreditOf: index.address,
            allocatedCredit: 6666,
          },
          {
            pool: market2,
            allocatedCreditOf: index.address,
            allocatedCredit: 6666,
          },
          {
            pool: market3,
            allocatedCreditOf: index.address,
            allocatedCredit: 6666,
          }
        ]
      })


      //Lev3.0
      await index.setLeverage("3000");
      await index.adjustAlloc();

      await verifyIndexStatus({
        index: index,
        totalSupply: 10000,
        totalLiquidity: 10000,
        totalAllocatedCredit: 30000,
        leverage: 3000,
        withdrawable: 10000,
        rate: "1000000000000000000"
      })

      await verifyVaultStatus({
        vault: vault,
        valueAll: 10000,
        totalAttributions: 10000
      })

      await verifyVaultStatusOf({
        vault: vault,
        target: index.address,
        attributions: 10000,
        underlyingValue: 10000
      })

      await verifyPoolsStatus_legacy({
        pools: [
          {
            pool: market1,
            totalLiquidity: 10000,
            availableBalance: 10000
          },
          {
            pool: market2,
            totalLiquidity: 10000,
            availableBalance: 10000
          },
          {
            pool: market3,
            totalLiquidity: 10000,
            availableBalance: 10000
          }
        ]
      })
      await verifyPoolsStatusOf({
        pools: [
          {
            pool: market1,
            allocatedCreditOf: index.address,
            allocatedCredit: 10000,
          },
          {
            pool: market2,
            allocatedCreditOf: index.address,
            allocatedCredit: 10000,
          },
          {
            pool: market3,
            allocatedCreditOf: index.address,
            allocatedCredit: 10000,
          }
        ]
      })
    });

    it("allows leverage rate decrement", async function () {
      await index.set("2", market3.address, "1000");

      await index.setLeverage("3000");
      await approveDeposit({
        token: dai,
        target: index,
        depositor: alice,
        amount: 10000
      })

      //Lev3.0
      await verifyIndexStatus({
        index: index,
        totalSupply: 10000,
        totalLiquidity: 10000,
        totalAllocatedCredit: 30000,
        leverage: 3000,
        withdrawable: 10000,
        rate: "1000000000000000000"
      })

      await verifyVaultStatus({
        vault: vault,
        valueAll: 10000,
        totalAttributions: 10000,
      })

      await verifyVaultStatusOf({
        vault: vault,
        target: index.address,
        attributions: 10000,
        underlyingValue: 10000
      })

      await verifyPoolsStatus_legacy({
        pools: [
          {
            pool: market1,
            totalLiquidity: 10000,
            availableBalance: 10000
          },
          {
            pool: market2,
            totalLiquidity: 10000,
            availableBalance: 10000
          },
          {
            pool: market3,
            totalLiquidity: 10000,
            availableBalance: 10000
          }
        ]
      })
      await verifyPoolsStatusOf({
        pools: [
          {
            pool: market1,
            allocatedCreditOf: index.address,
            allocatedCredit: 10000,
          },
          {
            pool: market2,
            allocatedCreditOf: index.address,
            allocatedCredit: 10000,
          },
          {
            pool: market3,
            allocatedCreditOf: index.address,
            allocatedCredit: 10000,
          }
        ]
      })

      //Lev2.0 when liquidity is locked
      let currentTimestamp = BigNumber.from(
        (await ethers.provider.getBlock("latest")).timestamp
      );
      //let endTime = await currentTimestamp.add(86400 * 10);
      await dai.connect(bob).approve(vault.address, 10000);
      await insure({
        pool: market1,
        insurer: bob,
        amount: 9999,
        maxCost: 10000,
        span: 86400 * 10,
        target: '0x4e69636b00000000000000000000000000000000000000000000000000000000'
      })

      await verifyIndexStatus({
        index: index,
        totalSupply: 10000,
        totalLiquidity: 10950,
        totalAllocatedCredit: 30000,
        leverage: 2739,
        withdrawable: 950,
        rate: "1095000000000000000"
      })

      await verifyPoolsStatus_legacy({
        pools: [
          {
            pool: market1,
            totalLiquidity: 10000,
            availableBalance: 1
          }
        ]
      })

      await verifyPoolsStatusOf({
        pools: [
          {
            pool: market1,
            allocatedCreditOf: index.address,
            allocatedCredit: 10000,
          }
        ]
      })


      await index.setLeverage("2000"); //deleverage
      await index.adjustAlloc();

      await verifyIndexStatus({
        index: index,
        totalSupply: 10000,
        totalLiquidity: 10950,
        totalAllocatedCredit: 21899,
        leverage: 1999,
        withdrawable: 0,
        rate: "1095000000000000000"
      })

      await verifyVaultStatus({
        vault: vault,
        valueAll: 10999,
        totalAttributions: 10999
      })

      await verifyVaultStatusOf({
        vault: vault,
        target: index.address,
        attributions: 10950,
        underlyingValue: 10950
      })

      await verifyPoolsStatus_legacy({
        pools: [
          {
            pool: market1,
            totalLiquidity: 9999,
            availableBalance: 0
          },
          {
            pool: market2,
            totalLiquidity: 5950,
            availableBalance: 5950
          },
          {
            pool: market3,
            totalLiquidity: 5950,
            availableBalance: 5950
          }
        ]
      })

      await verifyPoolsStatusOf({
        pools: [
          {
            pool: market1,
            allocatedCreditOf: index.address,
            allocatedCredit: 9999,
          },
          {
            pool: market2,
            allocatedCreditOf: index.address,
            allocatedCredit: 5950,
          },
          {
            pool: market3,
            allocatedCreditOf: index.address,
            allocatedCredit: 5950,
          }
        ]
      })

    });
  });

  describe.skip("Admin functions", function () {
    it("allows changing metadata", async function () {
      expect(await index.metadata()).to.equal("Here is metadata.");
      await index.changeMetadata("new metadata");
      expect(await index.metadata()).to.equal("new metadata");
    });
  });
});
