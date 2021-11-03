const { expect } = require("chai");
const { ethers } = require("hardhat");
const { BigNumber } = require("ethers");

describe("Parameters", function () {
  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

  beforeEach(async () => {
    //import
    [creator, alice, bob, chad, tom, test] = await ethers.getSigners();
    const Parameters = await ethers.getContractFactory("Parameters");

    parameters = await Parameters.deploy(creator.address);
  });
  describe("ownership functions", function () {
    //revert test
    it("test_commit_owner_only", async () => {
      await expect(
        parameters.connect(alice).commitTransferOwnership(alice.address)
      ).to.revertedWith("Restricted: caller is not allowed to operate");
    });

    it("test_apply_owner_only", async () => {
      await expect(
        parameters.connect(alice).applyTransferOwnership()
      ).to.revertedWith("Restricted: caller is not allowed to operate");
    });

    //test
    it("test_commitTransferOwnership", async () => {
      await parameters.commitTransferOwnership(alice.address);

      expect(await parameters.owner()).to.equal(creator.address);
      expect(await parameters.future_owner()).to.equal(alice.address);
    });

    it("test_applyTransferOwnership", async () => {
      await parameters.commitTransferOwnership(alice.address);
      await ethers.provider.send("evm_increaseTime", [86400 * 4]);
      await parameters.applyTransferOwnership();

      expect(await parameters.owner()).to.equal(alice.address);
      expect(await parameters.future_owner()).to.equal(alice.address);
    });

    it("test_apply_without_commit", async () => {
      await expect(parameters.applyTransferOwnership()).to.revertedWith(
        "dev: no active transfer"
      );
    });
  });
  describe("parameters functions", function () {
    it("registers universal params", async () => {
      await parameters.setCDSPremium(ZERO_ADDRESS, "1000");
      await parameters.setDepositFee(ZERO_ADDRESS, "1000");
      await parameters.setGrace(ZERO_ADDRESS, "1000");
      await parameters.setLockup(ZERO_ADDRESS, "1000");
      await parameters.setMindate(ZERO_ADDRESS, "1000");

      await parameters.setVault(ZERO_ADDRESS, test.address);
      await parameters.setWithdrawable(ZERO_ADDRESS, "1000");

      expect(await parameters.getCDSPremium("10000", creator.address)).to.equal(
        "100"
      );
      expect(await parameters.getDepositFee(10000, creator.address)).to.equal(
        "100"
      );
      expect(await parameters.getGrace(creator.address)).to.equal("1000");
      expect(await parameters.getLockup(creator.address)).to.equal("1000");
      expect(await parameters.getMin(creator.address)).to.equal("1000");
      expect(await parameters.getWithdrawable(creator.address)).to.equal(
        "1000"
      );
      expect(await parameters.getVault(test.address)).to.equal(ZERO_ADDRESS);
    });

    it("registers specific params for the specifed address", async () => {
      await parameters.setCDSPremium(ZERO_ADDRESS, "10000");
      await parameters.setDepositFee(ZERO_ADDRESS, "10000");
      await parameters.setGrace(test.address, "10000");
      await parameters.setLockup(test.address, "10000");
      await parameters.setMindate(test.address, "10000");
      await parameters.setVault(test.address, test.address);
      await parameters.setWithdrawable(test.address, "10000");

      expect(
        await parameters.connect(test).getCDSPremium("10000", test.address)
      ).to.equal("1000");
      expect(
        await parameters.connect(test).getDepositFee(10000, test.address)
      ).to.equal("1000");
      expect(await parameters.connect(test).getGrace(test.address)).to.equal(
        "10000"
      );
      expect(await parameters.connect(test).getLockup(test.address)).to.equal(
        "10000"
      );
      expect(await parameters.connect(test).getMin(test.address)).to.equal(
        "10000"
      );
      expect(
        await parameters.connect(test).getWithdrawable(test.address)
      ).to.equal("10000");
      expect(await parameters.getVault(test.address)).to.equal(test.address);
    });
  });
});
