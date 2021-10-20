const { expect } = require("chai");
const { ethers } = require("hardhat");
const { BigNumber } = require('ethers');

describe('LiquidityGauge', function() {
    const YEAR = BigNumber.from(86400*365);
    const WEEK = BigNumber.from(86400*7);

    const name = "InsureToken";
    const simbol = "Insure";
    const decimal = 18;

    const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

    const two_to_the_256_minus_1 = (BigNumber.from('2')).pow(BigNumber.from('256')).sub(BigNumber.from('1'));
    const ten_to_the_21 = BigNumber.from("1000000000000000000000");
    const ten_to_the_20 = BigNumber.from("100000000000000000000");
    const ten_to_the_19 = BigNumber.from("10000000000000000000");
    const ten_to_the_18 = BigNumber.from("1000000000000000000");
    const ten_to_the_17 = BigNumber.from("100000000000000000");
    const ten_to_the_12 = BigNumber.from("1000000000000");
    const ten_to_the_9 = BigNumber.from("1000000000");

    const BASE_DIGITS = BigNumber.from("1000000");
    const DIGITS_ADJUSTER = BigNumber.from("10");

    const k_initial = BigNumber.from("300100000");
    const b_initial = BigNumber.from("30000");
    const a_initial = BigNumber.from("300");

    //--------------------------------------------- functions -----------------------------------------------------------//

    function rdm_value(a){
        let rdm = BigNumber.from(Math.floor(Math.random()*a).toString());
        return rdm;
    }

    //--------------------------------------------- randomly excuted functions -----------------------------------------------------------//
    async function rule_getCurrentPremiumRate(){
        console.log("rule_getCurrentPremiumRate");

        let total = rdm_value(9007199254740991);
        let locked_amount = rdm_value(9007199254740991);

        if(total.gte(locked_amount)){
            let p_amount = await premium.getCurrentPremiumRate(total, locked_amount);

            let _util = locked_amount.mul(BASE_DIGITS).div(total);
            let Q = BASE_DIGITS.sub(_util).add(a_initial);
            let expected = k_initial.mul(365).sub(Q.mul(a_initial).mul(365)).add(Q.mul(b_initial)).div(Q).div(DIGITS_ADJUSTER)

            expect(p_amount).to.equal(expected);
        }
    }

    async function rule_getPremiumRate(){

        let total = rdm_value(9007199254740991);
        let locked_amount = rdm_value(total.toNumber());
        let amount = rdm_value((total.sub(locked_amount)).toNumber());
        let length = rdm_value(86400*365);

        total = total.mul(ten_to_the_9);
        locked_amount = locked_amount.mul(ten_to_the_9);
        amount = amount.mul(ten_to_the_9);

        console.log("rule_getPremiumRate", total, locked_amount, amount, length);

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
        await expect(p_amount).to.closeTo(expected, expected.div("10000"), "not precise enough");

    }

    //-------------------------------------------- function array -----------------------------------------------------------//
    let func = ["rule_getCurrentPremiumRate", "rule_getPremiumRate"];

    //------------------------------------------------- run tests ------------------------------------------------------------------------//


    beforeEach(async () => {
        [creator, alice] = await ethers.getSigners();

        const Calculator = await ethers.getContractFactory("ABDKMath64x64");
        const BondignPremium = await ethers.getContractFactory("BondingPremiumV2");
    
        calc = await Calculator.deploy();
        premium = await BondignPremium.deploy(calc.address);
    });

    describe("test_many", function(){
        for(let x=0; x<1; x++){
            it("try "+eval("x+1"), async()=>{
                for(let i=0;i<30;i++){
                    let n = await rdm_value(func.length);
                    await eval(func[n])();
                }
            });
        }

    });
});