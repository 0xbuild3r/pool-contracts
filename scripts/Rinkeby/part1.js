const hre = require("hardhat");
const ethers = hre.ethers;

/***
 * deploy USDC for test
 */

async function main() {
  //configs
  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
  [creator] = await ethers.getSigners();


  //contracts
  const USDC = await ethers.getContractFactory("ERC20Mock");


  //----- DEPLOY -----//
  const usdc = await USDC.deploy(creator.address);
  await usdc.deployed();
  console.log("usdc deployed to:", usdc.address);

}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });