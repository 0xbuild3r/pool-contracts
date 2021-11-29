const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

const chai = require('chai')
const { assert } = chai
const { expect } = require("chai");
const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");

const verifyBalance = async ({ token, address, expectedBalance }) => {
    const balance = await token.balanceOf(address)
    assert.equal(balance.toString(), expectedBalance.toString(), `token balance incorrect for ${token.address} with ${address}`)
}

const verifyBalances = async ({ token, userBalances }) => {
    const users = Object.keys(userBalances)
    for (i = 0; i < users.length; i++) {
      await verifyBalance({ token: token, address: users[i], expectedBalance: userBalances[users[i]]})
    }
}
const verifyAllowance = async ({ token, owner, spender, expectedAllowance }) => {
    const allowance = await token.allowance(owner, spender)
    assert.equal(+allowance, expectedAllowance, `allowance incorrect for ${token.address} owner ${owner} spender ${spender}`)
}


//univarsal
const verifyValueOfUnderlying = async({template, valueOfUnderlyingOf, valueOfUnderlying}) => {
    expect(await template.valueOfUnderlying(valueOfUnderlyingOf)).to.closeTo(valueOfUnderlying, 1); //rounding error
}

const verifyRate = async({template, rate}) => {
    expect(await template.rate()).to.equal(rate);
}



//pool
const _verifyPoolStatus = async({pool, totalLP, totalLiquidity, availableBalance, rate, utilizationRate, allInsuranceCount}) => {
    expect(await pool.totalSupply()).to.equal(totalLP);
    expect(await pool.totalLiquidity()).to.equal(totalLiquidity);
    expect(await pool.availableBalance()).to.equal(availableBalance);
    expect(await pool.rate()).to.equal(rate);
    expect(await pool.utilizationRate()).to.equal(utilizationRate);
    expect(await pool.allInsuranceCount()).to.equal(allInsuranceCount);
}

const verifyPoolsStatus = async({pools}) => {
    for (i = 0; i < pools.length; i++) {
        await _verifyPoolStatus({ 
            pool: pools[i].pool,
            totalLP: pools[i].totalLP,
            totalLiquidity: pools[i].totalLiquidity,
            availableBalance: pools[i].availableBalance,
            rate: pools[i].rate,
            utilizationRate: pools[i].utilizationRate,
            allInsuranceCount: pools[i].allInsuranceCount
        })
    }
}


const _verifyPoolStatusForIndex = async({pool, indexAddress, allocatedCredit, pendingPremium}) => {
    expect(await pool.allocatedCredit(indexAddress)).to.equal(allocatedCredit);
    expect(await pool.pendingPremium(indexAddress)).to.equal(pendingPremium);
}

const verifyPoolsStatusForIndex = async({pools}) => {
    for (i = 0; i < pools.length; i++) {
        await _verifyPoolStatusForIndex({ 
            pool: pools[i].pool,
            indexAddress: pools[i].allocatedCreditOf,
            allocatedCredit: pools[i].allocatedCredit,
            pendingPremium: pools[i].pendingPremium
        })
    }
}


//index
const verifyIndexStatus = async ({index, totalSupply, totalLiquidity, totalAllocatedCredit, leverage, withdrawable, rate}) => {
    expect(await index.totalSupply()).to.equal(totalSupply);
    expect(await index.totalLiquidity()).to.equal(totalLiquidity);
    expect(await index.totalAllocatedCredit()).to.equal(totalAllocatedCredit);
    expect(await index.leverage()).to.equal(leverage);
    expect(await index.withdrawable()).to.equal(withdrawable);
    expect(await index.rate()).to.equal(rate);
}


//cds
const verifyCDSStatus = async({cds, totalSupply, totalLiquidity, rate}) => {
    expect(await cds.totalSupply()).to.equal(totalSupply);
    expect(await cds.totalLiquidity()).to.equal(totalLiquidity);
    expect(await cds.rate()).to.equal(rate);
}


//Vault
const verifyVaultStatus = async({vault, valueAll, totalAttributions}) => {
    expect(await vault.valueAll()).to.equal(valueAll);
    expect(await vault.totalAttributions()).to.equal(totalAttributions);
}

const verifyVaultStatusOf = async({vault, target, attributions, underlyingValue}) => {
    expect(await vault.attributions(target)).to.equal(attributions);
    expect(await vault.underlyingValue(target)).to.equal(underlyingValue);
}

//



//function
const insure = async({pool, insurer, amount, maxCost, span, target}) => {
    let tx = await pool.connect(insurer).insure(amount, maxCost, span, target);

    let receipt = await tx.wait()
    let premium = receipt.events[4].args[6]

    return premium
}



Object.assign(exports, {
    verifyBalance,
    verifyBalances,
    verifyAllowance,

    //univarsal
    verifyValueOfUnderlying,
    verifyRate,

    //pool
    verifyPoolsStatus,
    verifyPoolsStatusForIndex,

    //index
    verifyIndexStatus,

    //cds
    verifyCDSStatus,

    //vault
    verifyVaultStatus,
    verifyVaultStatusOf,

    //function
    insure
})