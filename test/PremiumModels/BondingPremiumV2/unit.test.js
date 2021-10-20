const { expect } = require("chai");
const { ethers } = require("hardhat");
const { BigNumber } = require("ethers");

describe("test BondingPremium", () => {
  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

  const YEAR = BigNumber.from("86400").mul(365);

  const ten_to_the_18 = BigNumber.from("1000000000000000000");
  const ten_to_the_12 = BigNumber.from("1000000000000");
  const ten_to_the_6 = BigNumber.from("1000000");
  const ten_to_the_5 = BigNumber.from("100000");
  const BASE_DIGITS = BigNumber.from("1000000");

  const k_initial = BigNumber.from("300100000");
  const b_initial = BigNumber.from("30000");
  const a_initial = BigNumber.from("300");

  const low_b_initial = BigNumber.from("0");
  const low_liquidity_initial = BigNumber.from("0");
  const low_util_initial = BigNumber.from("0");

  //sqrt
  const ONE = ethers.BigNumber.from(1);
  const TWO = ethers.BigNumber.from(2);

  async function sqrt(value) {
    x = value;
    let z = x.add(ONE).div(TWO);
    let y = x;
    while (z.sub(y).isNegative()) {
      y = z;
      z = x.div(z).add(z).div(TWO);
    }
    return y;
  }

  beforeEach(async () => {
    [creator, alice] = await ethers.getSigners();

    const Calculator = await ethers.getContractFactory("ABDKMath64x64");
    const BondignPremium = await ethers.getContractFactory("BondingPremiumV2");

    calc = await Calculator.deploy();
    premium = await BondignPremium.deploy(calc.address);
  });

  describe("Condition", function () {
    it("contract should be deployed", async () => {
      await expect(premium.address).to.exist;
    });

    it("deploy fail", async()=>{
      const Calculator = await ethers.getContractFactory("ABDKMath64x64");
      const BondignPremium = await ethers.getContractFactory("BondingPremiumV2");

      calc = await Calculator.deploy();
      await expect(BondignPremium.deploy(ZERO_ADDRESS)).to.revertedWith("zero address");
    });

    it("check parameters", async () => {
      //initial values
      let b = b_initial;
      let k = k_initial;
      let a = a_initial;
      let low_risk_util = BigNumber.from("0");

      expect(await premium.k()).to.equal(k);
      expect(await premium.b()).to.equal(b);
      expect(await premium.a()).to.equal(a);
      expect(await premium.low_risk_util()).to.equal(low_risk_util);
    });
  });

  //this test will be performed plural in random test
  describe("test getCurrentPremiumRate", function () { 
    it("getCurrentPremiumRate correctlly 1", async () => {
      let total = BigNumber.from("1000000").mul(ten_to_the_18);
      let locked_amount = BigNumber.from("790000").mul(ten_to_the_18); //79.0000% utilized

      let p_amount = await premium.getCurrentPremiumRate(total, locked_amount);

      await expect(p_amount).to.equal(BigNumber.from("44135")); //44.135%
    });

    it("getCurrentPremiumRate correctlly 2", async () => {
      let total = BigNumber.from("1000000").mul(ten_to_the_18);
      let locked_amount = BigNumber.from("771863").mul(ten_to_the_18); //77.1863% utilized

      let p_amount = await premium.getCurrentPremiumRate(total, locked_amount);

      await expect(p_amount).to.equal(BigNumber.from("40000")); //40.000%
    });

    it("getCurrentPremiumRate correctlly low_risk", async () => {
      low_risk_b = BigNumber.from("5000"); //0.5%
      low_risk_liquidity = BigNumber.from("1000000000000"); //1M USDC
      low_risk_util = BigNumber.from("100000"); //10%

      await premium['setPremium2(uint256,uint256,uint256)'](low_risk_liquidity, low_risk_b, low_risk_util);
      
      let total = BigNumber.from("1000000").mul(ten_to_the_18);
      let locked_amount = BigNumber.from("10000").mul(ten_to_the_18); //1% utilized

      let p_amount = await premium.getCurrentPremiumRate(total, locked_amount);

      await expect(p_amount).to.equal(BigNumber.from("610")); //40.000% = 40000, 610 = 0.6%
    });
  });

  //this test will be performed plural in random test
  describe("test getPremium", function () {
    it("getPremium correctlly", async () => {
      let total = BigNumber.from("1000000").mul(ten_to_the_18);
      let locked_amount = BigNumber.from("0").mul(ten_to_the_18); //77.1863% utilized
      let amount = BigNumber.from("600000").mul(ten_to_the_18); //amount to buy
      let length = YEAR;

      let p_amount = await premium.getPremium(
        amount,
        length,
        total,
        locked_amount
      );
      
      let u1 = BASE_DIGITS.sub(locked_amount.mul(BASE_DIGITS).div(total));
      let u2 = BASE_DIGITS.sub(locked_amount.add(amount).mul(BASE_DIGITS).div(total));

      let u1_ln = BigNumber.from(String(Math.round(Math.log(u1.add(a_initial))*1000000000000))); //*1e12
      let u1_premium_left = k_initial.mul(365).mul(u1_ln);
      let u1_premium_right = b_initial.sub(a_initial.mul(365)).mul(u1).mul(ten_to_the_12);
      let u1_premium = u1_premium_left.add(u1_premium_right).div(ten_to_the_12);

      let u2_ln = BigNumber.from(String(Math.round(Math.log(u2.add(a_initial))*1000000000000))); //*1e12
      let u2_premium_left = k_initial.mul(365).mul(u2_ln);
      let u2_premium_right = b_initial.sub(a_initial.mul(365)).mul(u2).mul(ten_to_the_12);
      let u2_premium = u2_premium_left.add(u2_premium_right).div(ten_to_the_12);

      let expected = u1_premium.sub(u2_premium).mul(amount).mul(length).div(YEAR).div(ten_to_the_12);

      //0.001% precision is enough since premium rate represent 1e5 as 100% [100000 = 100%. 1 = 0.001%] (note: up to 0.000001% precise has passed)
      await expect(p_amount).to.closeTo(expected, expected.div("100000"), "not precise enough");

    });

    it("getPremium correctlly low_risk", async () => {
      //set low_risk
      low_risk_b = BigNumber.from("5000"); //0.5%
      low_risk_liquidity = BigNumber.from("1000000000000"); //1M USDC
      low_risk_util = BigNumber.from("100000"); //10%
      await premium['setPremium2(uint256,uint256,uint256)'](low_risk_liquidity, low_risk_b, low_risk_util);


      let total = BigNumber.from("1000000").mul(ten_to_the_18);
      let locked_amount = BigNumber.from("0").mul(ten_to_the_18); //0% utilized
      let amount = BigNumber.from("10000").mul(ten_to_the_18); //amount to buy
      let length = YEAR;

      let p_amount = await premium.getPremium(
        amount,
        length,
        total,
        locked_amount
      );
      
      let u1 = BASE_DIGITS.sub(locked_amount.mul(BASE_DIGITS).div(total));
      let u2 = BASE_DIGITS.sub(locked_amount.add(amount).mul(BASE_DIGITS).div(total));

      let u1_ln = BigNumber.from(String(Math.round(Math.log(u1.add(a_initial))*1000000000000))); //*1e12
      let u1_premium_left = k_initial.mul(365).mul(u1_ln);
      let u1_premium_right = low_risk_b.sub(a_initial.mul(365)).mul(u1).mul(ten_to_the_12);//low_risk_b
      let u1_premium = u1_premium_left.add(u1_premium_right).div(ten_to_the_12);

      let u2_ln = BigNumber.from(String(Math.round(Math.log(u2.add(a_initial))*1000000000000))); //*1e12
      let u2_premium_left = k_initial.mul(365).mul(u2_ln);
      let u2_premium_right = low_risk_b.sub(a_initial.mul(365)).mul(u2).mul(ten_to_the_12);//low_risk_b
      let u2_premium = u2_premium_left.add(u2_premium_right).div(ten_to_the_12);

      let expected = u1_premium.sub(u2_premium).mul(amount).mul(length).div(YEAR).div(ten_to_the_12);

      console.log(p_amount, expected);
      await expect(p_amount).to.closeTo(expected, expected.div("100000"), "not precise enough");

    });

    it("getPremium amount0", async () => {
      let total = BigNumber.from("1000000").mul(ten_to_the_18);
      let locked_amount = BigNumber.from("0").mul(ten_to_the_18); //77.1863% utilized
      let amount = BigNumber.from("0").mul(ten_to_the_18); //amount to buy
      let length = YEAR;

      let p_amount = await premium.getPremium(
        amount,
        length,
        total,
        locked_amount
      );

      await expect(p_amount).to.equal(0);
    });

    it("getPremium revert", async () => {
      let total = BigNumber.from("0").mul(ten_to_the_18);
      let locked_amount = BigNumber.from("0").mul(ten_to_the_18); //77.1863% utilized
      let amount = BigNumber.from("0").mul(ten_to_the_18); //amount to buy
      let length = YEAR;

      await expect(premium.getPremium(
        amount,
        length,
        total,
        locked_amount
      )).revertedWith("_totalLiquidity cannnot be 0");
    });

    it("getPremium revert", async () => {
      let total = BigNumber.from("10").mul(ten_to_the_18);
      let locked_amount = BigNumber.from("11").mul(ten_to_the_18); //77.1863% utilized
      let amount = BigNumber.from("0").mul(ten_to_the_18); //amount to buy
      let length = YEAR;

      await expect(premium.getPremium(
        amount,
        length,
        total,
        locked_amount
      )).revertedWith("Amount exceeds.");
    });


  });

  describe("test setPremium", function () {
    it("setPremium correctly", async () => {
      let b = BigNumber.from("500012"); //arbitrary
      let k = BigNumber.from("302927736472"); //arbitrary
      let a = ten_to_the_6
        .add(await sqrt(ten_to_the_6.mul(ten_to_the_6).add(k.mul(4))))
        .div(2)
        .sub(ten_to_the_6);

      await premium.setPremium(b, k);

      expect(await premium.k()).to.equal(k);
      expect(await premium.b()).to.equal(b);
      expect(await premium.a()).to.equal(a);
    });

    it("revert setPremium", async () => {
      let b = BigNumber.from("500012"); //arbitrary
      let k = BigNumber.from("302927736472"); //arbitrary

      await expect(premium.connect(alice).setPremium(b, k)).to.revertedWith(
        "Restricted: caller is not allowed to operate"
      );
    });
  });



  //-- config --//
  describe("test setPremium2", function () {
    it("setPremium2 correctly", async () => {
      expect(await premium.low_risk_b()).to.equal(low_b_initial);
      expect(await premium.low_risk_liquidity()).to.equal(low_liquidity_initial);
      expect(await premium.low_risk_util()).to.equal(low_util_initial);

      //new value
      low_risk_b = BigNumber.from("2030");
      low_risk_liquidity = BigNumber.from("102544520000000");
      low_risk_util = BigNumber.from("121400");

      //await premium.setPremium2(
      //  low_risk_liquidity,
      //  low_risk_b,
      //  low_risk_util,
      //  0
      //);
      await premium['setPremium2(uint256,uint256,uint256)'](low_risk_liquidity, low_risk_b, low_risk_util);
      
      expect(await premium.low_risk_b()).to.equal(low_risk_b);
      expect(await premium.low_risk_liquidity()).to.equal(low_risk_liquidity);
      expect(await premium.low_risk_util()).to.equal(low_risk_util);
    });

    it("revert setPremium2", async () => {
      //new value
      low_risk_b = BigNumber.from("4000030");

      await expect(premium['setPremium2(uint256,uint256,uint256)'](0, low_risk_b, 0)).to.revertedWith(
        "low_risk_base_fee must lower than base_fee"
      );
      await expect(
        premium.connect(alice)['setPremium2(uint256,uint256,uint256)'](0, 0, 0)
      ).to.revertedWith("Restricted: caller is not allowed to operate");
    });
  });

  describe("ownership functions", function () {
    //revert test
    it("test_commit_owner_only", async () => {
      await expect(
        premium.connect(alice).commitTransferOwnership(alice.address)
      ).to.revertedWith("dev: admin only");
    });

    it("test_accept_owner_only", async () => {
      await premium.commitTransferOwnership(alice.address);

      await expect(
        premium.acceptTransferOwnership()
      ).to.revertedWith("dev: future_admin only");
    });

    //test
    it("test_commitTransferOwnership", async () => {
      await premium.commitTransferOwnership(alice.address);

      expect(await premium.owner()).to.equal(creator.address);
      expect(await premium.future_owner()).to.equal(alice.address);
    });

    it("test_acceptTransferOwnership", async () => {
      await premium.commitTransferOwnership(alice.address);
      await premium.connect(alice).acceptTransferOwnership();

      expect(await premium.owner()).to.equal(alice.address);
      expect(await premium.future_owner()).to.equal(alice.address);
    });

    it("test_apply_without_commit", async () => {
      await expect(premium.acceptTransferOwnership()).to.revertedWith(
        "dev: no active transfer"
      );
    });
  });
});
