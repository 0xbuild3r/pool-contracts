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
  verifyVaultStatus_legacy,
  verifyVaultStatusOf_legacy,
  verifyValueOfUnderlying,
  verifyPoolsStatusForIndex,
  insure
} = require('../test-utils')


const {
  ZERO_ADDRESS,
  TEST_ADDRESS,
  NULL_ADDRESS,
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
  const owner = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
  const initialMint = BigNumber.from("100000");

  const depositAmount = BigNumber.from("10000");
  const depositAmountLarge = BigNumber.from("40000");
  const withdrawAmount = BigNumber.from("10000");
  const defaultRate = BigNumber.from("1000000"); //initial rate between USDC and LP token
  const insureAmount = BigNumber.from("10000");
  const maxCost = BigNumber.from("10000");
  let targetLev = BigNumber.from("2000");;
  const allocPoint1 = BigNumber.from("2000");
  const allocPoint2 = BigNumber.from("3000");
  const allocPoint3 = BigNumber.from("2000");
  const upperSlack = BigNumber.from("500"); // 90%
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

  let v = {};

  const addValueBatch = (amount, from, beneficiaries, shares, status) => {
    let ret = [];
    let attributions;
    if (status.totalAttributions.isZero()) {
      attributions = amount;
    } else {
      attributions = amount.mul(status.totalAttributions).div(status.balance);
    }
    u[from.address].balance = u[from.address].balance.sub(amount);

    status.balance = status.balance.add(amount);
    status.totalAttributions = status.totalAttributions.add(attributions);
    let allocation;
    for (let i = 0; i < 2; i++) {
      allocation = shares[i].mul(attributions).div(MAGIC_SCALE_1E6);
      status.attributions[beneficiaries[i]] = status.attributions[beneficiaries[i]].add(allocation);
      ret.push(allocation);
    }

    return ret;
  }

  const addValue = (amount, from, beneficiary, status) => {
    let attributions;
    if (status.totalAttributions.isZero()) {
      attributions = amount;
    } else {
      attributions = amount.mul(status.totalAttributions).div(status.balance);
    }
    status.balance = status.balance.add(amount);
    status.totalAttributions = status.totalAttributions.add(attributions);
    status.attributions[beneficiary] = status.attributions[beneficiary].add(attributions);
  }

  const withdrawValue = (amount, from, to, status) => {
    const attributions = amount.mul(status.totalAttributions).div(status.balance);
    status.attributions[from] = status.attributions[from].sub(attributions);
    status.totalAttributions = status.totalAttributions.sub(attributions);
    if (available().lt(amount)) {
      status.balance = status.balance.add(amount.sub(available()));
    }

    status.balance = status.balance.sub(amount);
  }

  const transferValue = (amount, from, to, status) => {
    const attributions = amount.mul(status.totalAttributions).div(status.balance);
    status.attributions[from] = status.attributions[from].sub(attributions);
    status.attributions[to] = status.attributions[to].add(attributions);
  }

  const borrowValue = (amount, from, to, status) => {
    status.debts[from] = status.debts[from].add(amount);
    status.totalDebt = status.totalDebt.add(amount);

    u[to.address].balance = u[to.address].balance.add(amount);
  }

  const offsetDebt = (amount, from, to, status) => {
    const attributions = amount.mul(status.totalAttributions).div(status.balance);
    status.attributions[from] = status.attributions[from].sub(attributions);
    status.totalAttributions = status.totalAttributions.sub(attributions);
    status.balance = status.balance.sub(amount);
    status.debts[to] = status.debts[to].sub(amount);
    status.totalDebt = status.totalDebt.sub(amount);
  }

  const transferDebt = (amount, from, status) => {
    if (!amount.isZero()) {
      status.debts[from] = status.debts[from].sub(amount);
      status.debts[ZERO_ADDRESS] = status.debts[ZERO_ADDRESS].add(amount);
    }
  }

  const repayDebt = (amount, from, to, status) => {
    const debt = status.debts[to];
    if (debt.gte(amount)) {
      status.debts[to] = status.debts[to].sub(amount);
      status.totalDebt = status.totalDebt.sub(amount);
      u[from.address].balance = u[from.address].balance.sub(amount);
    } else {
      status.debts[to] = ZERO;
      status.totalDebt = status.totalDebt.sub(debt);
      u[from.address].balance = u[from.address].balance.sub(debt);
    }
  }

  const withdrawAttribution = (amount, from, to, status) => {
    const val = amount.mul(status.balance).div(status.totalAttributions);
    status.attributions[from] = status.attributions[from].sub(amount);
    status.totalAttributions = status.totalAttributions.sub(amount);
    if (available().lt(val)) {
      status.balance = status.balance.add(val.sub(available()));
    }

    status.balance = status.balance.sub(val);
    u[to.address].balance = u[to.address].balance.add(val);
  }

  const transferAttribution = (amount, from, to, status) => {
    status.attributions[from] = status.attributions[from].sub(amount);
    status.attributions[to] = status.attributions[to].add(amount);
  }

  const underlyingValue = (addr, status) => {
    if (status.attributions[addr].gt(ZERO)) {
      return status.balance.mul(status.attributions[addr]).div(status.totalAttributions);
    }

    return ZERO;
  }

  const attributionValue = (amount, status) => {
    if (status.totalAttributions.gt(ZERO) && amount.gt(ZERO)) {
      return amount.mul(status.balance).div(status.totalAttributions);
    }

    return ZERO;
  }

  const approveDeposit = async ({ token, target, depositor, amount }) => {
    await token.connect(depositor).approve(vault.address, amount);
    let tx = await target.connect(depositor).deposit(amount);

    if (m[target.address].type == "index") {
      const totalLiquidity = totalLiquidity_Index();

      addValue(amount, depositor, target.address, v);

      let mintAmount;
      if (m[target.address].totalSupply.gt(ZERO) && totalLiquidity.gt(ZERO)) {
        mintAmount = amount.mul(m[target.address].totalSupply).div(totalLiquidity);
      } else if (m[target.address].totalSupply.gt(ZERO) && totalLiquidity.isZero()) {
        mintAmount = amount.mul(m[target.address].totalSupply);
      } else {
        mintAmount = amount;
      }

      u[`${depositor.address}`].balance = u[`${depositor.address}`].balance.sub(amount);
      u[`${depositor.address}`].deposited[`${target.address}`] = u[`${depositor.address}`].deposited[`${target.address}`].add(amount);
      u[`${depositor.address}`].lp[`${target.address}`] = u[`${depositor.address}`].lp[`${target.address}`].add(mintAmount);

      m[target.address].totalSupply = m[target.address].totalSupply.add(mintAmount);

      const totalLiquidityAfter = totalLiquidity.add(amount);
      const leverage = m[target.address].totalAllocatedCredit.mul(MAGIC_SCALE_1E6).div(totalLiquidityAfter);

      if ((targetLev.sub(lowerSlack)).gt(leverage)) {
        adjustAlloc(totalLiquidityAfter);
      }
    } else if (m[target.address].type == "pool") {
      //update user info => check
      let mintAmount = (await tx.wait()).events[2].args["mint"].toString();

      addValue(amount, depositor, target.address, v);

      m[target.address].totalSupply = m[target.address].totalSupply.add(mintAmount); //market1 (Pool) total LP balance increase as much as newly minted LP token.

      u[`${depositor.address}`].balance = u[`${depositor.address}`].balance.sub(amount);
      u[`${depositor.address}`].deposited[`${target.address}`] = u[`${depositor.address}`].deposited[`${target.address}`].add(amount);
      u[`${depositor.address}`].lp[`${target.address}`] = u[`${depositor.address}`].lp[`${target.address}`].add(mintAmount);

      expect(await token.balanceOf(depositor.address)).to.equal(u[`${depositor.address}`].balance);
      expect(await target.balanceOf(depositor.address)).to.equal(u[`${depositor.address}`].lp[`${target.address}`]);

      //2. update global and market status => check
      g.totalBalance = g.totalBalance.add(amount) //global balance of USDC increase

      //sanity check
      await verifyPoolsStatus({
        pools: [
          {
            pool: target,
            totalSupply: m[target.address].totalSupply,
            totalLiquidity: totalLiquidity_Pool(target.address), //all deposited amount 
            availableBalance: availableBalance(target.address, m[target.address]), //all amount - locked amount = available amount
            rate: rate_Pool(target.address),
            utilizationRate: utilizationRate(target.address),
            allInsuranceCount: m[target.address].allInsuranceCount,
          }
        ]
      });

      await verifyDebtOf({
        vault: vault,
        target: target.address,
        debt: v.debts[target.address],
      });

      //sanity check
      await verifyValueOfUnderlying({
        template: target,
        valueOfUnderlyingOf: depositor.address,
        valueOfUnderlying: valueOfUnderlying_Pool(target.address, depositor.address),
      });

    } else if (m[target.address].type == "cds") {

    }
  }

  const withdraw = async ({ target, withdrawer, amount }) => {
    let tx = await target.connect(withdrawer).withdraw(amount);

    if (m[target.address].type == "index") {
      const totalLiquidity = totalLiquidity_Index();
      const _amount = totalLiquidity.mul(amount).div(m[target.address].totalSupply);

      m[target.address].totalSupply = m[target.address].totalSupply.sub(amount);

      const liquidityAfter = totalLiquidity.sub(_amount);
      if (liquidityAfter.gt(ZERO)) {
        const leverage = m[index.address].totalAllocatedCredit.mul(MAGIC_SCALE_1E6).div(liquidityAfter);
        if (targetLev.add(upperSlack).lt(leverage)) {
          adjustAlloc(liquidityAfter);
        }
      } else {
        adjustAlloc(ZERO);
      }

      withdrawValue(_amount, target.address, withdrawer.address, v);
      u[`${withdrawer.address}`].balance = u[`${withdrawer.address}`].balance.add(_amount);
      u[`${withdrawer.address}`].deposited[`${target.address}`] = u[`${withdrawer.address}`].deposited[`${target.address}`].sub(amount);
      u[`${withdrawer.address}`].lp[`${target.address}`] = u[`${withdrawer.address}`].lp[`${target.address}`].sub(amount);
    } else if (m[target.address].type == "pool") {
      const _amount = amount.mul(originalLiquidity(target.address)).div(m[target.address].totalSupply);
      m[target.address].totalSupply = m[target.address].totalSupply.sub(amount);

      withdrawValue(_amount, target.address, withdrawer.address, v);

      u[`${withdrawer.address}`].balance = u[`${withdrawer.address}`].balance.add(_amount);
      u[`${withdrawer.address}`].deposited[`${target.address}`] = u[`${withdrawer.address}`].deposited[`${target.address}`].sub(amount);
      u[`${withdrawer.address}`].lp[`${target.address}`] = u[`${withdrawer.address}`].lp[`${target.address}`].sub(amount);
    } else if (m[target.address].type == "cds") {

    }
  }

  const adjustAlloc = async (liquidity) => {
    const targetCredit = targetLev.mul(liquidity).div(MAGIC_SCALE_1E6);
    let poolList = [];
    let allocatable = targetCredit;
    let allocatablePoints = m[`${index.address}`].totalAllocPoint;
    let poolAddr, allocation, market, target, current, available, delta;
    for (let i = 0; i < m[`${index.address}`].poolList.length; i++) {
      poolAddr = m[`${index.address}`].poolList[i];
      if (poolAddr !== ZERO_ADDRESS) {
        allocation = m[`${poolAddr}`].allocPoint;
        target = targetCredit.mul(allocation).div(allocatablePoints);
        market = markets.find(market => market.address === poolAddr);
        current = m[poolAddr].allocatedCredit;
        available = availableBalance(poolAddr, m[poolAddr]);
        if (current.gt(target) && current.sub(target).gt(available) || m[poolAddr].paused) {
          withdrawCredit(available, index.address, m[poolAddr]);
          m[`${index.address}`].totalAllocatedCredit = m[`${index.address}`].totalAllocatedCredit.sub(available);
          allocatable = allocatable.sub(current).add(available);
          allocatablePoints = allocatablePoints.sub(allocation);
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
        withdrawCredit(delta, index.address, m[poolAddr]);
        m[`${index.address}`].totalAllocatedCredit = m[`${index.address}`].totalAllocatedCredit.sub(delta);
      }
      if (current.lt(target)) {
        delta = target.sub(current);
        allocateCredit(delta, index.address, m[poolAddr]);
        m[`${index.address}`].totalAllocatedCredit = m[`${index.address}`].totalAllocatedCredit.add(delta);
      }
      if (current.eq(target)) {
        allocateCredit(ZERO, index.address, m[poolAddr]);
      }
    }
  }

  const insure = async ({ pool, insurer, amount, maxCost, span, target }) => {
    await dai.connect(insurer).approve(vault.address, maxCost);
    let tx = await pool.connect(insurer).insure(amount, maxCost, span, target);

    let receipt = await tx.wait();
    let premium = receipt.events[2].args['premium'];

    let fee = governanceFeeRate;

    const newAttribution = addValueBatch(premium, insurer, [pool.address, owner], [MAGIC_SCALE_1E6.sub(fee), fee], v);
    m[pool.address].lockedAmount = m[pool.address].lockedAmount.add(amount);
    m[pool.address].allInsuranceCount = m[pool.address].allInsuranceCount.add("1");

    if (m[pool.address].totalCredit.gt(ZERO)) {
      const attributionForIndex = newAttribution[0].mul(m[pool.address].totalCredit).div(totalLiquidity_Pool(pool.address));
      m[pool.address].attributionDebt = m[pool.address].attributionDebt.add(attributionForIndex);
      m[pool.address].rewardPerCredit = m[pool.address].rewardPerCredit.add(attributionForIndex.mul(MAGIC_SCALE_1E6).div(m[pool.address].totalCredit));
    }

    await verifyPoolsStatus({
      pools: [
        {
          pool: pool,
          totalSupply: m[pool.address].totalSupply,
          totalLiquidity: totalLiquidity_Pool(pool.address), //all deposited amount 
          availableBalance: availableBalance(pool.address, m[pool.address]), //all amount - locked amount = available amount
          rate: rate_Pool(pool.address),
          utilizationRate: utilizationRate(pool.address),
          allInsuranceCount: m[pool.address].allInsuranceCount,
        }
      ]
    });

    await verifyDebtOf({
      vault: vault,
      target: pool.address,
      debt: v.debts[pool.address],
    })

    await verifyVaultStatus({
      vault: vault,
      balance: v.balance,
      valueAll: v.balance,
      totalAttributions: v.totalAttributions,
      totalDebt: v.totalDebt,
    })

    //return value
    return premium
  }

  const redeem = async ({ pool, redeemer, id, proof }) => {
    let tx = await pool.connect(redeemer).redeem(id, proof);

    let receipt = await tx.wait();

    let insuredAmount = receipt.events[1].args['amount'];
    let payoutAmount = receipt.events[1].args['payout'];

    //update global and market status => check
    m[pool.address].lockedAmount = m[pool.address].lockedAmount.sub(insuredAmount);
    borrowValue(payoutAmount, pool.address, redeemer, v);

    expect(await dai.balanceOf(redeemer.address)).to.equal(u[`${redeemer.address}`].balance);

    await verifyPoolsStatus({
      pools: [
        {
          pool: pool,
          totalSupply: m[pool.address].totalSupply,
          totalLiquidity: totalLiquidity_Pool(pool.address), //all deposited amount 
          availableBalance: availableBalance(pool.address, m[pool.address]), //all amount - locked amount = available amount
          rate: rate_Pool(pool.address),
          utilizationRate: utilizationRate(pool.address),
          allInsuranceCount: m[pool.address].allInsuranceCount,
        }
      ]
    });

    await verifyDebtOf({
      vault: vault,
      target: pool.address,
      debt: v.debts[pool.address],
    });

    await verifyVaultStatus_legacy({
      vault: vault,
      valueAll: v.balance,
      totalAttributions: v.totalAttributions,
    })
  }

  const accuredPremiums = () => {
    let ret = ZERO;
    let poolAddr;
    for (let i = 0; i < m[`${index.address}`].poolList.length; i++) {
      poolAddr = m[`${index.address}`].poolList[i];
      ret.add(pendingPremium(poolAddr));
    }

    return ret;
  }

  const pendingPremium = (addr) => {
    return m[addr].allocatedCredit.isZero() ? ZERO : m[addr].allocatedCredit.mul(m[addr].rewardPerCredit).div(MAGIC_SCALE_1E6).sub(m[addr].rewardDebt);
  }

  const withdrawable = () => {
    if (leverage().gt(targetLev.add(upperSlack))) {
      return ZERO;
    } else {
      let poolAddr;
      let sum = ZERO;
      for (let i = 0; i < m[index.address].poolList.length; i++) {
        poolAddr = m[index.address].poolList[i];
        if (m[poolAddr].allocPoint.gt(ZERO)) {
          if (!totalLiquidity_Pool(poolAddr).isZero()) {
            sum = sum.add(m[poolAddr].lockedAmount.mul(m[poolAddr].totalCredit).div(totalLiquidity_Pool(poolAddr)));
          } else {
            sum = sum.add(m[poolAddr].lockedAmount);
          }
        }
      }

      return totalLiquidity_Index().sub(sum);
    }
  }

  const leverage = () => {
    if (totalLiquidity_Index().gt(ZERO)) {
      return m[`${index.address}`].totalAllocatedCredit.mul(MAGIC_SCALE_1E6).div(totalLiquidity_Index());
    }

    return ZERO;
  }

  const rate = () => {
    if (totalLiquidity_Index().gt(ZERO)) {
      return totalLiquidity_Index().mul(MAGIC_SCALE_1E6).div(m[`${index.address}`].totalSupply);
    }

    return ZERO;
  }

  const approveDepositAndWithdrawRequest = async ({ token, target, depositor, amount }) => {
    await approveDeposit({ token, target, depositor, amount });
    await target.connect(depositor).requestWithdraw(amount);
  }

  const compensate = async ({ target, compensator, amount }) => {
    await target.connect(compensator).compensate(amount);

    let ret;
    const value = underlyingValue(target.address, v);
    if (value.gte(amount)) {
      offsetDebt(amount, target.address, compensator.address, v);
      ret = amount;
    } else {
      if (totalLiquidity_Index().lt(amount)) {
        const shortage = amount.sub(value);
        const cds = ZERO;
        ret = value.add(cds);
      }
      offsetDebt(ret, target.address, compensator.address, v);
    }

    adjustAlloc(totalLiquidity_Index());
  }

  const resume_Pool = async (market) => {
    await market.resume();

    const debt = v.debts[market.address];
    const totalCredit = m[market.address].totalCredit;
    const deductionFromIndex = debt.mul(totalCredit).mul(MAGIC_SCALE_1E6).div(totalLiquidity_Pool(market.address));
    const credit = m[market.address].allocatedCredit;
    let actualDeduction = ZERO;
    if (credit.gt(ZERO)) {
      const shareOfIndex = credit.mul(MAGIC_SCALE_1E6).div(totalCredit);
      const redeemAmount = divCeil(deductionFromIndex, shareOfIndex);
      actualDeduction = await compensate({
        target: index,
        compensator: pool,
        amount: redeemAmount,
      });
    }

    const deductionFromPool = debt.sub(deductionFromIndex.div(MAGIC_SCALE_1E6));
    const shortage = deductionFromIndex.div(MAGIC_SCALE_1E6).sub(actualDeduction);

    if (deductionFromPool.gt(ZERO)) {
      offsetDebt(deductionFromPool, market.address, market.address, v);
    }

    transferDebt(shortage, market.address, v);

    await verifyDebtOf({
      vault: vault,
      target: market.address,
      debt: v.debts[market.address],
    })
  }

  const divCeil = (a, b) => {
    const c = a.div(b);
    if (!a.mod(b).isZero())
      c = c.add(1);

    return c;
  }

  const applyCover = async ({ pool, pending, targetAddress, payoutNumerator, payoutDenominator, incidentTimestamp }) => {

    const padded1 = ethers.utils.hexZeroPad("0x1", 32);
    const padded2 = ethers.utils.hexZeroPad("0x2", 32);

    const getLeaves = (target) => {
      return [
        { id: padded1, account: target },
        { id: padded1, account: TEST_ADDRESS },
        { id: padded2, account: TEST_ADDRESS },
        { id: padded2, account: NULL_ADDRESS },
        { id: padded1, account: NULL_ADDRESS },
      ];
    };

    //test for pools
    const encoded = (target) => {
      const list = getLeaves(target);

      return list.map(({ id, account }) => {
        return ethers.utils.solidityKeccak256(
          ["bytes32", "address"],
          [id, account]
        );
      });
    };

    const leaves = encoded(targetAddress);
    const tree = await new MerkleTree(leaves, keccak256, { sort: true });
    const root = await tree.getHexRoot();
    const leaf = leaves[0];
    const proof = await tree.getHexProof(leaf);

    await pool.applyCover(
      pending,
      payoutNumerator,
      payoutDenominator,
      incidentTimestamp,
      root,
      "raw data",
      "metadata"
    );

    return proof
  }

  const set = async (id, addr, allocPoint) => {
    await index.set(id, addr, allocPoint);

    if (m[index.address].poolList.length <= id) {
      m[index.address].poolList.push(addr);
    } else {
      const poolAddr = m[index.address].poolList[id];
      if (poolAddr !== ZERO_ADDRESS && poolAddr !== addr) {
        withdrawCredit(m[poolAddr].allocatedCredit, index.address, m[poolAddr]);
      }
      m[index.address].poolList[id] = addr;
    }

    if (m[index.address].totalAllocPoint.gt(ZERO)) {
      m[index.address].totalAllocPoint = m[index.address].totalAllocPoint.sub(m[addr].allocPoint).add(allocPoint);
    } else {
      m[index.address].totalAllocPoint = allocPoint;
    }

    m[addr].allocPoint = allocPoint;
    adjustAlloc(totalLiquidity_Index());
  }

  const totalLiquidity_Index = () => {
    return underlyingValue(index.address, v).add(accuredPremiums());
  }

  const originalLiquidity = (addr) => {
    return underlyingValue(addr, v).sub(attributionValue(m[addr].attributionDebt, v));
  }

  const totalLiquidity_Pool = (addr) => {
    return originalLiquidity(addr).add(m[addr].totalCredit);
  }

  const rate_Index = () => {
    if (m[index.address].totalSupply.gt(ZERO)) {
      return totalLiquidity_Index().mul(MAGIC_SCALE_1E6).div(m[index.address].totalSupply);
    }

    return ZERO;
  }

  const rate_Pool = (addr) => {
    if (m[addr].totalSupply.gt(ZERO)) {
      return originalLiquidity(addr).mul(MAGIC_SCALE_1E6).div(m[addr].totalSupply);
    }

    return ZERO;
  }

  const valueOfUnderlying_Pool = (poolAddr, ownerAddr) => {
    const balance = u[`${ownerAddr}`].lp[poolAddr];
    if (balance.isZero()) {
      return ZERO;
    }

    return balance.mul(originalLiquidity(poolAddr)).div(m[poolAddr].totalSupply);
  }

  const valueOfUnderlying_Index = (ownerAddr) => {
    const balance = u[`${ownerAddr}`].lp[index.address];
    if (balance.isZero()) {
      return ZERO;
    }

    return balance.mul(totalLiquidity_Index()).div(m[index.address].totalSupply);
  }

  const utilizationRate = (addr) => {
    if (m[addr].lockedAmount.gt(ZERO)) {
      return m[addr].lockedAmount.mul(MAGIC_SCALE_1E6).div(totalLiquidity_Pool(addr));
    }

    return ZERO;
  }

  const availableBalance = (addr, status) => {
    if (totalLiquidity_Pool(addr).gt(ZERO)) {
      return totalLiquidity_Pool(addr).sub(status.lockedAmount);
    }

    return ZERO;
  }

  const available = () => {
    return v.balance.sub(v.totalDebt);
  }

  const allocateCredit = (amount, from, status) => {
    let pending;
    if (status.allocatedCredit.gt(ZERO)) {
      pending = status.allocatedCredit.mul(status.rewardPerCredit).div(MAGIC_SCALE_1E6).sub(status.rewardDebt);
      if (pending.gt(ZERO)) {
        transferAttribution(pending, from, index.address, v);
        status.attributionDebt = status.attributionDebt.sub(pending);
      }
    }
    if (amount.gt(ZERO)) {
      status.totalCredit = status.totalCredit.add(amount);
      status.allocatedCredit = status.allocatedCredit.add(amount);
    }

    status.rewardDebt = status.allocatedCredit.mul(status.rewardPerCredit).div(MAGIC_SCALE_1E6);
  }

  const withdrawCredit = (amount, from, status) => {
    let pending;
    pending = status.allocatedCredit.mul(status.rewardPerCredit).div(MAGIC_SCALE_1E6).sub(status.rewardDebt);
    if (amount.gt(ZERO)) {
      status.totalCredit = status.totalCredit.sub(amount);
      status.allocatedCredit = status.allocatedCredit.sub(amount);
    }

    if (pending.gt(ZERO)) {
      transferAttribution(pending, from, index.address, v);
      status.attributionDebt = status.attributionDebt.sub(pending);

      status.rewardDebt = status.allocatedCredit.mul(status.rewardPerCredit).div(MAGIC_SCALE_1E6);
    }
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
    await dai.mint(tom.address, initialMint);

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
    await parameters.setMinDate(ZERO_ADDRESS, "604800");
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
      attributionDebt: ZERO,
      lockedAmount: ZERO,
      totalCredit: ZERO,
      rewardPerCredit: ZERO,
      totalSupply: ZERO,
      allocatedCredit: ZERO,
      allocPoint: ZERO,
      rewardDebt: ZERO,
      allInsuranceCount: ZERO,
      paused: false,
    };

    m[`${market2.address}`] = {
      type: "pool",
      attributionDebt: ZERO,
      lockedAmount: ZERO,
      totalCredit: ZERO,
      rewardPerCredit: ZERO,
      totalSupply: ZERO,
      allocatedCredit: ZERO,
      allocPoint: ZERO,
      rewardDebt: ZERO,
      allInsuranceCount: ZERO,
      paused: false,
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
      totalAllocatedCredit: ZERO,
      totalAllocPoint: ZERO,
      poolList: [],
      children: []
    };

    v = {
      balance: ZERO,
      attributions: {
        [market1.address]: ZERO,
        [market2.address]: ZERO,
        [index.address]: ZERO,
        [cds.address]: ZERO,
        [owner]: ZERO,
      },
      totalAttributions: ZERO,
      debts: {
        [market1.address]: ZERO,
        [market2.address]: ZERO,
        [index.address]: ZERO,
        [cds.address]: ZERO,
      },
      totalDebt: ZERO,
    };

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

    await set(0, market1.address, allocPoint1);
    await set(1, market2.address, allocPoint2);
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
            totalAllocatedCredit: ZERO,
            children: []
          };
          break;

        case 'pool':
          m[`${markets[i].address}`] = {
            ...m[`${markets[i].address}`],
            attributionDebt: ZERO,
            lockedAmount: ZERO,
            totalCredit: ZERO,
            rewardPerCredit: ZERO,
            totalSupply: ZERO,
            allocatedCredit: ZERO,
            rewardDebt: ZERO,
            allInsuranceCount: ZERO,
            paused: false,
          };
          break;

        case 'cds':
          break;
      }
    }

    v.balance = ZERO;
    v.attributions[market1.address] = ZERO;
    v.attributions[market2.address] = ZERO;
    v.attributions[index.address] = ZERO;
    v.attributions[cds.address] = ZERO;
    v.attributions[owner.address] = ZERO;
    v.totalAttributions = ZERO;
    v.debts[market1.address] = ZERO;
    v.debts[market2.address] = ZERO;
    v.debts[index.address] = ZERO;
    v.debts[cds.address] = ZERO;
    v.totalDebt = ZERO;
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

  describe("deposit", function () {
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
      await verifyIndexStatus({
        index: index,
        totalSupply: m[index.address].totalSupply, //LP token
        totalLiquidity: totalLiquidity_Index(), //underwriting asset
        totalAllocatedCredit: m[index.address].totalAllocatedCredit, //totalLiquidity * (leverage/1000000)
        totalAllocPoint: m[index.address].totalAllocPoint,
        targetLev: targetLev,
        leverage: leverage(),
        withdrawable: withdrawable(), //un-utilized underwriting asset
        rate: rate_Index(),
      });

      // pool
      await verifyPoolsStatus_legacy({
        pools: [
          {
            pool: market1,
            totalLiquidity: totalLiquidity_Pool(market1.address),
            availableBalance: availableBalance(market1.address, m[market1.address]),
          },
          {
            pool: market2,
            totalLiquidity: totalLiquidity_Pool(market2.address),
            availableBalance: availableBalance(market2.address, m[market2.address]),
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
      await verifyVaultStatus_legacy({
        vault: vault,
        valueAll: v.balance,
        totalAttributions: v.totalAttributions,
      });

      await verifyVaultStatusOf_legacy({
        vault: vault,
        target: index.address,
        attributions: v.totalAttributions,
        underlyingValue: v.balance.mul(v.attributions[index.address]).div(v.totalAttributions) // v.balance.mul(v.totalAttributions).div(v.totalAttributions)
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
  });

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
      await verifyIndexStatus({
        index: index,
        totalSupply: m[index.address].totalSupply, //LP token
        totalLiquidity: totalLiquidity_Index(), //underwriting asset
        totalAllocatedCredit: m[index.address].totalAllocatedCredit,
        totalAllocPoint: m[index.address].totalAllocPoint,
        targetLev: targetLev,
        leverage: leverage(),
        withdrawable: withdrawable(), //un-utilized underwriting asset
        rate: rate_Index(),
      });

      //pool
      await verifyPoolsStatus_legacy({
        pools: [
          {
            pool: market1,
            totalLiquidity: totalLiquidity_Pool(market1.address),
            availableBalance: availableBalance(market1.address, m[market1.address]),
          },
          {
            pool: market2,
            totalLiquidity: totalLiquidity_Pool(market2.address),
            availableBalance: availableBalance(market2.address, m[market2.address]),
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
      await verifyVaultStatus_legacy({
        vault: vault,
        valueAll: v.balance,
        totalAttributions: v.totalAttributions,
      });

      await verifyVaultStatusOf_legacy({
        vault: vault,
        target: index.address,
        attributions: v.totalAttributions,
        underlyingValue: v.balance.mul(v.attributions[index.address]).div(v.totalAttributions) // v.balance.mul(v.totalAttributions).div(v.totalAttributions)
      });
    });

    it("success withdraw", async function () {
      await moveForwardPeriods(8);
      await withdraw({
        target: index,
        withdrawer: alice,
        amount: withdrawAmount
      });

      //CHECK ALL STATUS
      //index
      await verifyIndexStatus({
        index: index,
        totalSupply: m[index.address].totalSupply, //LP token
        totalLiquidity: totalLiquidity_Index(), //underwriting asset
        totalAllocatedCredit: m[index.address].totalAllocatedCredit,
        totalAllocPoint: m[index.address].totalAllocPoint,
        targetLev: targetLev,
        leverage: leverage(),
        withdrawable: withdrawable(), //un-utilized underwriting asset
        rate: rate(),
      });

      // //pool
      await verifyPoolsStatus_legacy({
        pools: [
          {
            pool: market1,
            totalLiquidity: totalLiquidity_Pool(market1.address),
            availableBalance: availableBalance(market1.address, m[market1.address]),
          },
          {
            pool: market2,
            totalLiquidity: totalLiquidity_Pool(market2.address),
            availableBalance: availableBalance(market2.address, m[market2.address]),
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
      await verifyVaultStatus_legacy({
        vault: vault,
        valueAll: v.balance,
        totalAttributions: v.totalAttributions,
      });

      await verifyVaultStatusOf_legacy({
        vault: vault,
        target: index.address,
        attributions: v.attributions[index.address],
        underlyingValue: underlyingValue(index.address, v),
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
        withdrawer: alice,
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

      await insure({
        pool: market1,
        insurer: bob,
        amount: insureAmount,
        maxCost: insureAmount,
        span: WEEK,
        target: padded1
      });

      expect(await market1.utilizationRate()).to.equal(utilizationRate(market1.address));
      expect(await market2.utilizationRate()).to.equal(utilizationRate(market2.address));

      await verifyBalance({
        token: dai,
        address: bob.address,
        expectedBalance: u[bob.address].balance,
      });

      await verifyBalance({
        token: dai,
        address: vault.address,
        expectedBalance: v.balance,
      });


      //after insure(), index gains premium, but aloc doesn't change. this leads to lower the leverage
      await verifyIndexStatus({
        index: index,
        totalSupply: m[index.address].totalSupply, //LP token
        totalLiquidity: totalLiquidity_Index(), //underwriting asset
        totalAllocatedCredit: m[index.address].totalAllocatedCredit,
        totalAllocPoint: m[index.address].totalAllocPoint,
        targetLev: targetLev,
        leverage: leverage(),
        withdrawable: withdrawable(), //un-utilized underwriting asset
        rate: rate(),
      });

      await moveForwardPeriods(8);

      await expect(index.connect(alice).withdraw(withdrawable().add(1))).to.revertedWith(
        "ERROR: WITHDRAW_INSUFFICIENT_LIQUIDITY"
      );
    });
  });

  describe("else", function () {
    beforeEach(async () => {
    });

    it("accrues premium after deposit", async function () {
      await approveDepositAndWithdrawRequest({
        token: dai,
        target: index,
        depositor: alice,
        amount: depositAmount,
      })

      await verifyIndexStatus({
        index: index,
        totalSupply: m[index.address].totalSupply, //LP token
        totalLiquidity: totalLiquidity_Index(), //underwriting asset
        totalAllocatedCredit: m[index.address].totalAllocatedCredit,
        totalAllocPoint: m[index.address].totalAllocPoint,
        targetLev: targetLev,
        leverage: leverage(),
        withdrawable: withdrawable(), //un-utilized underwriting asset
        rate: rate_Index(),
      });

      await approveDepositAndWithdrawRequest({
        token: dai,
        target: market1,
        depositor: alice,
        amount: depositAmount,
      });

      expect(await index.rate()).to.equal(rate_Index());

      await insure({
        pool: market1,
        insurer: bob,
        amount: insureAmount,
        maxCost: insureAmount,
        span: WEEK,
        target: padded1,
      });

      await verifyBalance({
        token: dai,
        address: bob.address,
        expectedBalance: u[bob.address].balance,
      })

      await verifyIndexStatus({
        index: index,
        totalSupply: m[index.address].totalSupply, //LP token
        totalLiquidity: totalLiquidity_Index(), //underwriting asset
        totalAllocatedCredit: m[index.address].totalAllocatedCredit,
        totalAllocPoint: m[index.address].totalAllocPoint,
        targetLev: targetLev,
        leverage: leverage(),
        withdrawable: withdrawable(), //un-utilized underwriting asset
        rate: rate_Index(),
      });

      expect(await market1.pendingPremium(index.address)).to.equal(pendingPremium(market1.address)); //verify

      //withdrawal also harvest accrued premium
      await moveForwardPeriods(369);

      await market1.unlock("0");

      await verifyBalance({
        token: dai,
        address: alice.address,
        expectedBalance: u[alice.address].balance,
      });

      await withdraw({
        target: market1,
        withdrawer: alice,
        amount: withdrawAmount,
      });
      //Harvested premium is reflected on their account balance
      await verifyBalance({
        token: dai,
        address: alice.address,
        expectedBalance: u[alice.address].balance,
      });
    });

    it("also transfers lockup period when iToken is transferred", async function () {
      await approveDepositAndWithdrawRequest({
        token: dai,
        target: index,
        depositor: alice,
        amount: depositAmount,
      });

      await verifyIndexStatus({
        index: index,
        totalSupply: m[index.address].totalSupply, //LP token
        totalLiquidity: totalLiquidity_Index(), //underwriting asset
        totalAllocatedCredit: m[index.address].totalAllocatedCredit,
        totalAllocPoint: m[index.address].totalAllocPoint,
        targetLev: targetLev,
        leverage: leverage(),
        withdrawable: withdrawable(), //un-utilized underwriting asset
        rate: rate_Index(),
      });

      //Transferring iToken, which also distribute premium
      const transferAmount = BigNumber.from("10000");
      await index.connect(alice).transfer(tom.address, transferAmount);
      u[alice.address].lp[index.address] = u[alice.address].lp[index.address].sub(transferAmount);
      u[tom.address].lp[index.address] = u[tom.address].lp[index.address].add(transferAmount);
      await index.connect(tom).requestWithdraw(withdrawAmount);

      await expect(index.connect(alice).withdraw(withdrawAmount)).to.revertedWith(
        "ERROR: WITHDRAWAL_QUEUE"
      );
      await expect(index.connect(tom).withdraw(withdrawAmount)).to.revertedWith(
        "ERROR: WITHDRAWAL_QUEUE"
      );

      await moveForwardPeriods(8);

      await expect(index.connect(alice).withdraw(withdrawAmount)).to.revertedWith(
        "ERROR: WITHDRAWAL_EXCEEDED_REQUEST"
      );

      await withdraw({
        target: index,
        withdrawer: tom,
        amount: withdrawAmount,
      });

      await verifyBalance({
        token: dai,
        address: tom.address,
        expectedBalance: u[tom.address].balance,
      });
    });

    it("DISABLE deposit when paused(withdrawal is possible)", async function () {

      await approveDepositAndWithdrawRequest({
        token: dai,
        target: index,
        depositor: alice,
        amount: depositAmount,
      });

      await verifyIndexStatus({
        index: index,
        totalSupply: m[index.address].totalSupply, //LP token
        totalLiquidity: totalLiquidity_Index(), //underwriting asset
        totalAllocatedCredit: m[index.address].totalAllocatedCredit,
        totalAllocPoint: m[index.address].totalAllocPoint,
        targetLev: targetLev,
        leverage: leverage(),
        withdrawable: withdrawable(), //un-utilized underwriting asset
        rate: rate_Index(),
      });

      await index.setPaused(true);

      await expect(index.connect(alice).deposit(depositAmount)).to.revertedWith(
        "ERROR: DEPOSIT_DISABLED"
      );

      await moveForwardPeriods(8);

      await withdraw({
        target: index,
        withdrawer: alice,
        amount: withdrawAmount,
      });

      await verifyBalance({
        token: dai,
        address: alice.address,
        expectedBalance: u[alice.address].balance,
      });
    });

    it("DISABLE deposit and withdrawal when reporting or payingout", async function () {
      //Can deposit and withdraw in normal time
      await approveDepositAndWithdrawRequest({
        token: dai,
        target: index,
        depositor: alice,
        amount: depositAmount,
      });

      await verifyIndexStatus({
        index: index,
        totalSupply: m[index.address].totalSupply, //LP token
        totalLiquidity: totalLiquidity_Index(), //underwriting asset
        totalAllocatedCredit: m[index.address].totalAllocatedCredit,
        totalAllocPoint: m[index.address].totalAllocPoint,
        targetLev: targetLev,
        leverage: leverage(),
        withdrawable: withdrawable(), //un-utilized underwriting asset
        rate: rate_Index(),
      });

      await moveForwardPeriods(8);

      let incident = await now();

      await applyCover({
        pool: market1,
        pending: 604800,
        targetAddress: ZERO_ADDRESS, //everyone
        payoutNumerator: 5000,
        payoutDenominator: 10000,
        incidentTimestamp: incident
      });

      await expect(index.connect(alice).deposit(depositAmount)).to.revertedWith(
        "ERROR: DEPOSIT_DISABLED"
      );
      await expect(index.connect(alice).withdraw(withdrawAmount)).to.revertedWith(
        "ERROR: WITHDRAWAL_PENDING"
      );

      await moveForwardPeriods(11);

      await market1.resume();
      await index.resume();

      await verifyIndexStatus({
        index: index,
        totalSupply: m[index.address].totalSupply, //LP token
        totalLiquidity: totalLiquidity_Index(), //underwriting asset
        totalAllocatedCredit: m[index.address].totalAllocatedCredit,
        totalAllocPoint: m[index.address].totalAllocPoint,
        targetLev: targetLev,
        leverage: leverage(),
        withdrawable: withdrawable(), //un-utilized underwriting asset
        rate: rate_Index(),
      });

      await withdraw({
        target: index,
        withdrawer: alice,
        amount: withdrawAmount,
      });

      await verifyBalance({
        token: dai,
        address: alice.address,
        expectedBalance: u[alice.address].balance,
      });
    });

    it("devaluate underlying when cover claim is accepted", async function () {
      await approveDepositAndWithdrawRequest({
        token: dai,
        target: market1,
        depositor: alice,
        amount: depositAmount,
      });

      await verifyPoolsStatus_legacy({
        pools: [
          {
            pool: market1,
            totalLiquidity: totalLiquidity_Pool(market1.address),
            availableBalance: availableBalance(market1.address, m[market1.address]),
          },
          {
            pool: market2,
            totalLiquidity: totalLiquidity_Pool(market2.address),
            availableBalance: availableBalance(market2.address, m[market2.address]),
          }
        ]
      });

      await dai.connect(bob).approve(vault.address, 10000);

      await insure({
        pool: market1,
        insurer: bob,
        amount: insureAmount,
        maxCost: insureAmount,
        span: WEEK,
        target: padded1
      });

      expect(await dai.balanceOf(bob.address)).to.equal(u[bob.address].balance);

      let incident = await now();

      let proof = await applyCover({
        pool: market1,
        pending: 604800,
        targetAddress: ZERO_ADDRESS, //everyone
        payoutNumerator: 5000,
        payoutDenominator: 10000,
        incidentTimestamp: incident
      });

      await verifyVaultStatus_legacy({
        vault: vault,
        valueAll: v.balance,
        totalAttributions: v.totalAttributions,
      });

      await verifyVaultStatusOf_legacy({
        vault: vault,
        target: market1.address,
        attributions: v.attributions[market1.address],
        underlyingValue: underlyingValue(market1.address, v),
      });

      await verifyVaultStatusOf_legacy({
        vault: vault,
        target: index.address,
        attributions: v.attributions[index.address],
        underlyingValue: underlyingValue(index.address, v),
      });


      expect(await market1.totalLiquidity()).to.closeTo(totalLiquidity_Pool(market1.address), "1");

      await redeem({
        pool: market1,
        redeemer: bob,
        id: 0,
        proof: proof,
      });

      await expect(market1.connect(alice).unlock("0")).to.revertedWith(
        "ERROR: UNLOCK_BAD_COINDITIONS"
      );

      await verifyIndexStatus({
        index: index,
        totalSupply: m[index.address].totalSupply, //LP token
        totalLiquidity: totalLiquidity_Index(), //underwriting asset
        totalAllocatedCredit: m[index.address].totalAllocatedCredit,
        totalAllocPoint: m[index.address].totalAllocPoint,
        targetLev: targetLev,
        leverage: leverage(),
        withdrawable: withdrawable(), //un-utilized underwriting asset
        rate: rate_Index(),
      });

      await verifyVaultStatus_legacy({
        vault: vault,
        valueAll: v.balance,
        totalAttributions: v.totalAttributions,
      });

      await verifyPoolsStatus_legacy({
        pools: [
          {
            pool: market1,
            totalLiquidity: totalLiquidity_Pool(market1.address),
            availableBalance: availableBalance(market1.address, m[market1.address]),
          },
          {
            pool: market2,
            totalLiquidity: totalLiquidity_Pool(market2.address),
            availableBalance: availableBalance(market2.address, m[market2.address]),
          }
        ]
      });

      await moveForwardPeriods(11);
      await resume_Pool(market1);
      await index.resume();

      await withdraw({
        target: market1,
        withdrawer: alice,
        amount: withdrawAmount,
      });

      await verifyBalances({
        token: dai,
        userBalances: {
          [alice.address]: u[alice.address].balance,
          [bob.address]: u[bob.address].balance,
        },
      });

      //Simulation: full payout
      await approveDepositAndWithdrawRequest({
        token: dai,
        target: market1,
        depositor: alice,
        amount: depositAmount,
      });

      await verifyIndexStatus({
        index: index,
        totalSupply: m[index.address].totalSupply, //LP token
        totalLiquidity: totalLiquidity_Index(), //underwriting asset
        totalAllocatedCredit: m[index.address].totalAllocatedCredit,
        totalAllocPoint: m[index.address].totalAllocPoint,
        targetLev: targetLev,
        leverage: leverage(),
        withdrawable: withdrawable(), //un-utilized underwriting asset
        rate: rate_Index(),
      });

      currentTimestamp = BigNumber.from(
        (await ethers.provider.getBlock("latest")).timestamp
      );

      await insure({
        pool: market1,
        insurer: bob,
        amount: insureAmount,
        maxCost: insureAmount,
        span: WEEK,
        target: padded1
      });

      incident = await now();

      proof = await applyCover({
        pool: market1,
        pending: 604800,
        targetAddress: ZERO_ADDRESS, //everyone
        payoutNumerator: 5000,
        payoutDenominator: 10000,
        incidentTimestamp: incident
      });

      await redeem({
        pool: market1,
        redeemer: bob,
        id: 1,
        proof: proof,
      });

      await verifyIndexStatus({
        index: index,
        totalSupply: m[index.address].totalSupply, //LP token
        totalLiquidity: totalLiquidity_Index(), //underwriting asset
        totalAllocatedCredit: m[index.address].totalAllocatedCredit,
        totalAllocPoint: m[index.address].totalAllocPoint,
        targetLev: targetLev,
        leverage: leverage(),
        withdrawable: withdrawable(), //un-utilized underwriting asset
        rate: rate_Index(),
      });

      expect(await index.valueOfUnderlying(alice.address)).to.equal(valueOfUnderlying_Index(alice.address));

      await moveForwardPeriods(11);

      await resume_Pool(market1);
      await index.resume();

      await withdraw({
        target: market1,
        withdrawer: alice,
        amount: withdrawAmount,
      })

      await verifyBalances({
        token: dai,
        userBalances: {
          [alice.address]: u[alice.address].balance,
          [bob.address]: u[bob.address].balance,
        }
      })
    });

  });

  describe("Index parameter configurations (case un-equal allocation)", function () {
    before(async () => {
      //Deploy a new pool
      const PoolTemplate = await ethers.getContractFactory("PoolTemplate");
      await factory.createMarket(
        poolTemplate.address,
        "Here is metadata.",
        [0],
        [dai.address, dai.address, registry.address, parameters.address, creator.address]
      );
      const marketAddress5 = await factory.markets(4);
      market3 = await PoolTemplate.attach(marketAddress5);

      m[`${market3.address}`] = {
        type: "pool",
        attributionDebt: ZERO,
        lockedAmount: ZERO,
        totalCredit: ZERO,
        rewardPerCredit: ZERO,
        totalSupply: ZERO,
        allocatedCredit: ZERO,
        allocPoint: ZERO,
        rewardDebt: ZERO,
        allInsuranceCount: ZERO,
        paused: false,
      };

      v.attributions[market3.address] = ZERO;
      v.debts[market3.address] = ZERO;

      markets.push(market3);
    });

    it("allows new pool addition", async function () {
      await approveDeposit({
        token: dai,
        target: index,
        depositor: alice,
        amount: depositAmount,
      });

      //Case1: Add when no liquidity is locked
      //Expected results: Reallocaet liquidity market1: 5000, market2: 5000, market3: 10000
      await set(2, market3.address, allocPoint3);

      await verifyIndexStatus({
        index: index,
        totalSupply: m[index.address].totalSupply, //LP token
        totalLiquidity: totalLiquidity_Index(), //underwriting asset
        totalAllocatedCredit: m[index.address].totalAllocatedCredit,
        totalAllocPoint: m[index.address].totalAllocPoint,
        targetLev: targetLev,
        leverage: leverage(),
        withdrawable: withdrawable(), //un-utilized underwriting asset
        rate: rate_Index(),
      });

      await verifyVaultStatus_legacy({
        vault: vault,
        valueAll: v.balance,
        totalAttributions: v.totalAttributions,
      })

      await verifyVaultStatusOf_legacy({
        vault: vault,
        target: index.address,
        attributions: v.attributions[index.address],
        underlyingValue: underlyingValue(index.address, v),
      });


      await verifyPoolsStatus_legacy({
        pools: [
          {
            pool: market1,
            totalLiquidity: totalLiquidity_Pool(market1.address),
            availableBalance: availableBalance(market1.address, m[market1.address]),
          },
          {
            pool: market2,
            totalLiquidity: totalLiquidity_Pool(market2.address),
            availableBalance: availableBalance(market2.address, m[market2.address]),
          },
          {
            pool: market3,
            totalLiquidity: totalLiquidity_Pool(market3.address),
            availableBalance: availableBalance(market3.address, m[market3.address]),
          },
        ]
      })

      await verifyPoolsStatusForIndex({
        pools: [
          {
            pool: market1,
            indexAddress: index.address,
            allocatedCredit: m[market1.address].allocatedCredit,
            pendingPremium: pendingPremium(market1.address),
          },
          {
            pool: market2,
            indexAddress: index.address,
            allocatedCredit: m[market2.address].allocatedCredit,
            pendingPremium: pendingPremium(market2.address),
          },
          {
            pool: market3,
            indexAddress: index.address,
            allocatedCredit: m[market3.address].allocatedCredit,
            pendingPremium: pendingPremium(market3.address),
          }
        ]
      })

      await set(2, market3.address, ZERO);

      //Case2: Add when liquidity is locked(market1 has locked 50% of index liquidity ) d
      await verifyIndexStatus({
        index: index,
        totalSupply: m[index.address].totalSupply, //LP token
        totalLiquidity: totalLiquidity_Index(), //underwriting asset
        totalAllocatedCredit: m[index.address].totalAllocatedCredit,
        totalAllocPoint: m[index.address].totalAllocPoint,
        targetLev: targetLev,
        leverage: leverage(),
        withdrawable: withdrawable(), //un-utilized underwriting asset
        rate: rate_Index(),
      });

      await verifyPoolsStatus_legacy({
        pools: [
          {
            pool: market1,
            totalLiquidity: totalLiquidity_Pool(market1.address),
            availableBalance: availableBalance(market1.address, m[market1.address]),
          },
          {
            pool: market2,
            totalLiquidity: totalLiquidity_Pool(market2.address),
            availableBalance: availableBalance(market2.address, m[market2.address]),
          },
          {
            pool: market3,
            totalLiquidity: totalLiquidity_Pool(market3.address),
            availableBalance: availableBalance(market3.address, m[market3.address]),
          },
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
          },
          {
            pool: market3,
            allocatedCreditOf: index.address,
            allocatedCredit: m[market3.address].allocatedCredit,
          }
        ]
      });

      await approveDeposit({
        token: dai,
        target: market1,
        depositor: alice,
        amount: insureAmount,
      });

      await insure({
        pool: market1,
        insurer: bob,
        amount: insureAmount,
        maxCost: insureAmount,
        span: WEEK,
        target: padded1
      });

      expect(await market1.totalLiquidity()).to.equal(totalLiquidity_Pool(market1.address));
      expect(await market1.availableBalance()).to.equal(availableBalance(market1.address, m[market1.address]));

      await verifyIndexStatus({
        index: index,
        totalSupply: m[index.address].totalSupply, //LP token
        totalLiquidity: totalLiquidity_Index(), //underwriting asset
        totalAllocatedCredit: m[index.address].totalAllocatedCredit,
        totalAllocPoint: m[index.address].totalAllocPoint,
        targetLev: targetLev,
        leverage: leverage(),
        withdrawable: withdrawable(), //un-utilized underwriting asset
        rate: rate_Index(),
      });

      await set(2, market3.address, allocPoint3);

      await verifyIndexStatus({
        index: index,
        totalSupply: m[index.address].totalSupply, //LP token
        totalLiquidity: totalLiquidity_Index(), //underwriting asset
        totalAllocatedCredit: m[index.address].totalAllocatedCredit,
        totalAllocPoint: m[index.address].totalAllocPoint,
        targetLev: targetLev,
        leverage: leverage(),
        withdrawable: withdrawable(), //un-utilized underwriting asset
        rate: rate_Index(),
      });

      await verifyPoolsStatus_legacy({
        pools: [
          {
            pool: market1,
            totalLiquidity: totalLiquidity_Pool(market1.address),
            availableBalance: availableBalance(market1.address, m[market1.address]),
          },
          {
            pool: market2,
            totalLiquidity: totalLiquidity_Pool(market2.address),
            availableBalance: availableBalance(market2.address, m[market2.address]),
          },
          {
            pool: market3,
            totalLiquidity: totalLiquidity_Pool(market3.address),
            availableBalance: availableBalance(market3.address, m[market3.address]),
          },
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
          },
          {
            pool: market3,
            allocatedCreditOf: index.address,
            allocatedCredit: m[market3.address].allocatedCredit,
          }
        ]
      });
    });

    it("allows pool removal", async function () {
      await approveDeposit({
        token: dai,
        target: index,
        depositor: alice,
        amount: depositAmount,
      });

      await set(2, market3.address, allocPoint3);

      //before remomval
      await verifyIndexStatus({
        index: index,
        totalSupply: m[index.address].totalSupply, //LP token
        totalLiquidity: totalLiquidity_Index(), //underwriting asset
        totalAllocatedCredit: m[index.address].totalAllocatedCredit,
        totalAllocPoint: m[index.address].totalAllocPoint,
        targetLev: targetLev,
        leverage: leverage(),
        withdrawable: withdrawable(), //un-utilized underwriting asset
        rate: rate_Index(),
      });

      await verifyVaultStatus_legacy({
        vault: vault,
        valueAll: v.balance,
        totalAttributions: v.totalAttributions,
      })

      await verifyVaultStatusOf_legacy({
        vault: vault,
        target: index.address,
        attributions: v.attributions[index.address],
        underlyingValue: underlyingValue(index.address, v),
      });

      await verifyPoolsStatus_legacy({
        pools: [
          {
            pool: market1,
            totalLiquidity: totalLiquidity_Pool(market1.address),
            availableBalance: availableBalance(market1.address, m[market1.address]),
          },
          {
            pool: market2,
            totalLiquidity: totalLiquidity_Pool(market2.address),
            availableBalance: availableBalance(market2.address, m[market2.address]),
          },
          {
            pool: market3,
            totalLiquidity: totalLiquidity_Pool(market3.address),
            availableBalance: availableBalance(market3.address, m[market3.address]),
          },
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
          },
          {
            pool: market3,
            allocatedCreditOf: index.address,
            allocatedCredit: m[market3.address].allocatedCredit,
          }
        ]
      });

      //after remomval
      await set(2, market3.address, ZERO);

      await verifyIndexStatus({
        index: index,
        totalSupply: m[index.address].totalSupply, //LP token
        totalLiquidity: totalLiquidity_Index(), //underwriting asset
        totalAllocatedCredit: m[index.address].totalAllocatedCredit,
        totalAllocPoint: m[index.address].totalAllocPoint,
        targetLev: targetLev,
        leverage: leverage(),
        withdrawable: withdrawable(), //un-utilized underwriting asset
        rate: rate_Index(),
      });

      await verifyVaultStatus_legacy({
        vault: vault,
        valueAll: v.balance,
        totalAttributions: v.totalAttributions,
      })

      await verifyVaultStatusOf_legacy({
        vault: vault,
        target: index.address,
        attributions: v.attributions[index.address],
        underlyingValue: underlyingValue(index.address, v),
      });

      await verifyPoolsStatus_legacy({
        pools: [
          {
            pool: market1,
            totalLiquidity: totalLiquidity_Pool(market1.address),
            availableBalance: availableBalance(market1.address, m[market1.address]),
          },
          {
            pool: market2,
            totalLiquidity: totalLiquidity_Pool(market2.address),
            availableBalance: availableBalance(market2.address, m[market2.address]),
          },
          {
            pool: market3,
            totalLiquidity: totalLiquidity_Pool(market3.address),
            availableBalance: availableBalance(market3.address, m[market3.address]),
          },
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
          },
          {
            pool: market3,
            allocatedCreditOf: index.address,
            allocatedCredit: m[market3.address].allocatedCredit,
          }
        ]
      });
    });


    it("mimics pool removal if the pool is paused", async function () {
      await set(2, market3.address, allocPoint1);

      await approveDeposit({
        token: dai,
        target: index,
        depositor: alice,
        amount: depositAmount,
      });

      //before remomval

      await verifyIndexStatus({
        index: index,
        totalSupply: m[index.address].totalSupply, //LP token
        totalLiquidity: totalLiquidity_Index(), //underwriting asset
        totalAllocatedCredit: m[index.address].totalAllocatedCredit,
        totalAllocPoint: m[index.address].totalAllocPoint,
        targetLev: targetLev,
        leverage: leverage(),
        withdrawable: withdrawable(), //un-utilized underwriting asset
        rate: rate_Index(),
      });

      await verifyVaultStatus_legacy({
        vault: vault,
        valueAll: v.balance,
        totalAttributions: v.totalAttributions,
      })

      await verifyVaultStatusOf_legacy({
        vault: vault,
        target: index.address,
        attributions: v.attributions[index.address],
        underlyingValue: underlyingValue(index.address, v),
      });

      await verifyPoolsStatus_legacy({
        pools: [
          {
            pool: market1,
            totalLiquidity: totalLiquidity_Pool(market1.address),
            availableBalance: availableBalance(market1.address, m[market1.address]),
          },
          {
            pool: market2,
            totalLiquidity: totalLiquidity_Pool(market2.address),
            availableBalance: availableBalance(market2.address, m[market2.address]),
          },
          {
            pool: market3,
            totalLiquidity: totalLiquidity_Pool(market3.address),
            availableBalance: availableBalance(market3.address, m[market3.address]),
          },
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
          },
          {
            pool: market3,
            allocatedCreditOf: index.address,
            allocatedCredit: m[market3.address].allocatedCredit,
          }
        ]
      });

      //after remomval
      await market3.setPaused(true);
      await adjustAlloc(totalLiquidity_Index());

      expect(await market1.allocatedCredit(index.address)).to.equal(m[market1.address].allocatedCredit);

      await verifyIndexStatus({
        index: index,
        totalSupply: m[index.address].totalSupply, //LP token
        totalLiquidity: totalLiquidity_Index(), //underwriting asset
        totalAllocatedCredit: m[index.address].totalAllocatedCredit,
        totalAllocPoint: m[index.address].totalAllocPoint,
        targetLev: targetLev,
        leverage: leverage(),
        withdrawable: withdrawable(), //un-utilized underwriting asset
        rate: rate_Index(),
      });

      await verifyVaultStatus_legacy({
        vault: vault,
        valueAll: v.balance,
        totalAttributions: v.totalAttributions,
      })

      await verifyVaultStatusOf_legacy({
        vault: vault,
        target: index.address,
        attributions: v.attributions[index.address],
        underlyingValue: underlyingValue(index.address, v),
      });

      await verifyPoolsStatus_legacy({
        pools: [
          {
            pool: market1,
            totalLiquidity: totalLiquidity_Pool(market1.address),
            availableBalance: availableBalance(market1.address, m[market1.address]),
          },
          {
            pool: market2,
            totalLiquidity: totalLiquidity_Pool(market2.address),
            availableBalance: availableBalance(market2.address, m[market2.address]),
          },
          {
            pool: market3,
            totalLiquidity: totalLiquidity_Pool(market3.address),
            availableBalance: availableBalance(market3.address, m[market3.address]),
          },
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
          },
          {
            pool: market3,
            allocatedCreditOf: index.address,
            allocatedCredit: m[market3.address].allocatedCredit,
          }
        ]
      });
    });

    it("allows leverage rate increment", async function () {
      await set(2, market3.address, allocPoint1);

      await approveDeposit({
        token: dai,
        target: index,
        depositor: alice,
        amount: depositAmount,
      })

      //lev 2.0
      await verifyIndexStatus({
        index: index,
        totalSupply: m[index.address].totalSupply, //LP token
        totalLiquidity: totalLiquidity_Index(), //underwriting asset
        totalAllocatedCredit: m[index.address].totalAllocatedCredit,
        totalAllocPoint: m[index.address].totalAllocPoint,
        targetLev: targetLev,
        leverage: leverage(),
        withdrawable: withdrawable(), //un-utilized underwriting asset
        rate: rate_Index(),
      });

      await verifyVaultStatus_legacy({
        vault: vault,
        valueAll: v.balance,
        totalAttributions: v.totalAttributions,
      })

      await verifyVaultStatusOf_legacy({
        vault: vault,
        target: index.address,
        attributions: v.attributions[index.address],
        underlyingValue: underlyingValue(index.address, v),
      });

      await verifyPoolsStatus_legacy({
        pools: [
          {
            pool: market1,
            totalLiquidity: totalLiquidity_Pool(market1.address),
            availableBalance: availableBalance(market1.address, m[market1.address]),
          },
          {
            pool: market2,
            totalLiquidity: totalLiquidity_Pool(market2.address),
            availableBalance: availableBalance(market2.address, m[market2.address]),
          },
          {
            pool: market3,
            totalLiquidity: totalLiquidity_Pool(market3.address),
            availableBalance: availableBalance(market3.address, m[market3.address]),
          },
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
          },
          {
            pool: market3,
            allocatedCreditOf: index.address,
            allocatedCredit: m[market3.address].allocatedCredit,
          }
        ]
      });


      //Lev3.0
      targetLev = BigNumber.from("3000");
      await index.setLeverage(targetLev);
      await adjustAlloc(totalLiquidity_Index());

      await verifyIndexStatus({
        index: index,
        totalSupply: m[index.address].totalSupply, //LP token
        totalLiquidity: totalLiquidity_Index(), //underwriting asset
        totalAllocatedCredit: m[index.address].totalAllocatedCredit,
        totalAllocPoint: m[index.address].totalAllocPoint,
        targetLev: targetLev,
        leverage: leverage(),
        withdrawable: withdrawable(), //un-utilized underwriting asset
        rate: rate_Index(),
      });

      await verifyVaultStatus_legacy({
        vault: vault,
        valueAll: v.balance,
        totalAttributions: v.totalAttributions,
      })

      await verifyVaultStatusOf_legacy({
        vault: vault,
        target: index.address,
        attributions: v.attributions[index.address],
        underlyingValue: underlyingValue(index.address, v),
      });

      await verifyPoolsStatus_legacy({
        pools: [
          {
            pool: market1,
            totalLiquidity: totalLiquidity_Pool(market1.address),
            availableBalance: availableBalance(market1.address, m[market1.address]),
          },
          {
            pool: market2,
            totalLiquidity: totalLiquidity_Pool(market2.address),
            availableBalance: availableBalance(market2.address, m[market2.address]),
          },
          {
            pool: market3,
            totalLiquidity: totalLiquidity_Pool(market3.address),
            availableBalance: availableBalance(market3.address, m[market3.address]),
          },
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
          },
          {
            pool: market3,
            allocatedCreditOf: index.address,
            allocatedCredit: m[market3.address].allocatedCredit,
          }
        ]
      });
    });

    it("allows leverage rate decrement", async function () {
      await set(2, market3.address, allocPoint1);

      await index.setLeverage(targetLev);
      await approveDeposit({
        token: dai,
        target: index,
        depositor: alice,
        amount: depositAmount,
      });

      //Lev3.0
      await verifyIndexStatus({
        index: index,
        totalSupply: m[index.address].totalSupply, //LP token
        totalLiquidity: totalLiquidity_Index(), //underwriting asset
        totalAllocatedCredit: m[index.address].totalAllocatedCredit,
        totalAllocPoint: m[index.address].totalAllocPoint,
        targetLev: targetLev,
        leverage: leverage(),
        withdrawable: withdrawable(), //un-utilized underwriting asset
        rate: rate_Index(),
      });

      await verifyVaultStatus_legacy({
        vault: vault,
        valueAll: v.balance,
        totalAttributions: v.totalAttributions,
      })

      await verifyVaultStatusOf_legacy({
        vault: vault,
        target: index.address,
        attributions: v.attributions[index.address],
        underlyingValue: underlyingValue(index.address, v),
      });

      await verifyPoolsStatus_legacy({
        pools: [
          {
            pool: market1,
            totalLiquidity: totalLiquidity_Pool(market1.address),
            availableBalance: availableBalance(market1.address, m[market1.address]),
          },
          {
            pool: market2,
            totalLiquidity: totalLiquidity_Pool(market2.address),
            availableBalance: availableBalance(market2.address, m[market2.address]),
          },
          {
            pool: market3,
            totalLiquidity: totalLiquidity_Pool(market3.address),
            availableBalance: availableBalance(market3.address, m[market3.address]),
          },
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
          },
          {
            pool: market3,
            allocatedCreditOf: index.address,
            allocatedCredit: m[market3.address].allocatedCredit,
          }
        ]
      });

      //Lev2.0 when liquidity is locked
      let currentTimestamp = BigNumber.from(
        (await ethers.provider.getBlock("latest")).timestamp
      );
      //let endTime = await currentTimestamp.add(86400 * 10);
      await approveDeposit({
        token: dai,
        target: market1,
        depositor: alice,
        amount: depositAmount,
      });

      await insure({
        pool: market1,
        insurer: bob,
        amount: insureAmount,
        maxCost: insureAmount,
        span: WEEK,
        target: padded1
      });

      await verifyIndexStatus({
        index: index,
        totalSupply: m[index.address].totalSupply, //LP token
        totalLiquidity: totalLiquidity_Index(), //underwriting asset
        totalAllocatedCredit: m[index.address].totalAllocatedCredit,
        totalAllocPoint: m[index.address].totalAllocPoint,
        targetLev: targetLev,
        leverage: leverage(),
        withdrawable: withdrawable(), //un-utilized underwriting asset
        rate: rate_Index(),
      });

      await verifyPoolsStatus_legacy({
        pools: [
          {
            pool: market1,
            totalLiquidity: totalLiquidity_Pool(market1.address),
            availableBalance: availableBalance(market1.address, m[market1.address]),
          },
        ]
      });

      await verifyPoolsStatusForIndex_legacy({
        pools: [
          {
            pool: market1,
            allocatedCreditOf: index.address,
            allocatedCredit: m[market1.address].allocatedCredit,
          },
        ]
      });

      targetLev = BigNumber.from("2000");
      await index.setLeverage(targetLev); //deleverage
      await adjustAlloc(totalLiquidity_Index());

      await verifyIndexStatus({
        index: index,
        totalSupply: m[index.address].totalSupply, //LP token
        totalLiquidity: totalLiquidity_Index(), //underwriting asset
        totalAllocatedCredit: m[index.address].totalAllocatedCredit,
        totalAllocPoint: m[index.address].totalAllocPoint,
        targetLev: targetLev,
        leverage: leverage(),
        withdrawable: withdrawable(), //un-utilized underwriting asset
        rate: rate_Index(),
      });

      await verifyVaultStatus_legacy({
        vault: vault,
        valueAll: v.balance,
        totalAttributions: v.totalAttributions,
      })

      await verifyVaultStatusOf_legacy({
        vault: vault,
        target: index.address,
        attributions: v.attributions[index.address],
        underlyingValue: underlyingValue(index.address, v),
      });

      await verifyPoolsStatus_legacy({
        pools: [
          {
            pool: market1,
            totalLiquidity: totalLiquidity_Pool(market1.address),
            availableBalance: availableBalance(market1.address, m[market1.address]),
          },
          {
            pool: market2,
            totalLiquidity: totalLiquidity_Pool(market2.address),
            availableBalance: availableBalance(market2.address, m[market2.address]),
          },
          {
            pool: market3,
            totalLiquidity: totalLiquidity_Pool(market3.address),
            availableBalance: availableBalance(market3.address, m[market3.address]),
          },
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
          },
          {
            pool: market3,
            allocatedCreditOf: index.address,
            allocatedCredit: m[market3.address].allocatedCredit,
          }
        ]
      });
    });
  });

  describe("Admin functions", function () {
    it("allows changing metadata", async function () {
      expect(await index.metadata()).to.equal("Here is metadata.");
      await index.changeMetadata("new metadata");
      expect(await index.metadata()).to.equal("new metadata");
    });
  });
});
