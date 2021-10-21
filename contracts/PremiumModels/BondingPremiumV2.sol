pragma solidity 0.8.7;

/***
* @title BondingPremiumV2
* @author InsureDAO
* SPDX-License-Identifier: MIT
* @notice Calculate premium to purchase insurance. low_risk_fee assumes only USDC.
*/

/**
* Premium Model Explanation: https://insuredao.gitbook.io/insuredao/advanced/premium-pricing
* Interactive Graph: https://www.desmos.com/calculator/urb8toypkh
*/

import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "./ABDKMath64x64.sol";

contract BondingPremiumV2 {
    using SafeMath for uint256;

    ABDKMath64x64 calculator;

    event CommitOwnership(address future_owner);
    event AcceptOwnership(address owner);

    uint256 public k; //k
    uint256 public b; //b
    uint256 public a; //a

    uint256 public low_risk_util; //expressed in util rate
    uint256 public low_risk_liquidity; //expressed in total liquidity amount
    uint256 public low_risk_b;

    address public owner;
    address public future_owner;

    uint256 BASE_DIGITS = uint256(1e6); //bonding curve graph takes 1e6 as 100.0000%
    uint256 BASE_DIGITS_x2 = uint256(1e12); //BASE_DIGITS^2
    uint256 DIGITS_ADJUSTER = uint256(10); //adjuster of 1e6 to 1e5 (100.0000% to 100.000%)

    modifier onlyOwner() {
        require(msg.sender == owner, "Restricted: caller is not allowed to operate");
        _;
    }

    constructor(address _calculator) {
        require(_calculator != address(0), "zero address");

        owner = msg.sender;
        calculator = ABDKMath64x64(_calculator);
        
        //setPremium()
        b = 30000; //3%
        k = 300100000;
        a = 300; //(BASE_DIGITS.add(sqrt(BASE_DIGITS.mul(BASE_DIGITS).add(k.mul(4))))).div(2).sub(BASE_DIGITS)

        //not implementing low_risk fee initially
    }

    /**
    * @notice Get yearly premium rate. This returns percentage in form of 1e5. (100000 = 100.000%)
    * @param _totalLiquidity total liquidity token amount in the insurance pool.
    * @param _lockedAmount utilized token amount of the insurance pool.
    */
    function getCurrentPremiumRate(uint256 _totalLiquidity, uint256 _lockedAmount)
        public
        view
        returns (uint256)
    {
        // utilization rate (0~1000000)
        uint256 _util = _lockedAmount.mul(BASE_DIGITS).div(_totalLiquidity);

        // yearly premium rate
        uint256 _premiumRate;

        uint256 Q = BASE_DIGITS.sub(_util).add(a); //(x+a)
        if (_util < low_risk_util && _totalLiquidity > low_risk_liquidity) {
            //utilizatio < 10% && totalliquidity > low_risk_border (easily acomplished if leverage applied)
            _premiumRate = k
            .mul(365)
            .sub(Q.mul(a).mul(365))
            .add(Q.mul(low_risk_b))
            .div(Q)
            .div(DIGITS_ADJUSTER); //change 100.0000% to 100.000%
        } else {
            _premiumRate = k
            .mul(365)
            .sub(Q.mul(a).mul(365))
            .add(Q.mul(b))
            .div(Q)
            .div(DIGITS_ADJUSTER); //change 100.0000% to 100.000%
        }

        //Return premium
        return _premiumRate;
    }

    /***
    * @notice Get premium rate.
    * @param _amount  token amount of insurance be bought
    * @param _totalLiquidity total liquidity token amount in the insurance pool.
    * @param _lockedAmount utilized token amount of the insurance pool.
    * @dev This returns value without divides by BASE_DEGITS to keep precision. have to devide by BASE_DEGITS at last of getPremium().
    */
    function getPremiumRate(
        uint256 _amount,
        uint256 _totalLiquidity,
        uint256 _lockedAmount
    ) public view returns (uint256) {

        uint256 _util = _lockedAmount.mul(BASE_DIGITS).div(_totalLiquidity);
            
        uint256 _b = b;
        if (_util < low_risk_util && _totalLiquidity > low_risk_liquidity) 
            _b = low_risk_b;
        
        uint256 u1 = BASE_DIGITS.sub(_lockedAmount.mul(BASE_DIGITS).div(_totalLiquidity)); //util rate before. 1000000 = 100.000%
        uint256 u2 = BASE_DIGITS.sub(_lockedAmount.add(_amount).mul(BASE_DIGITS).div(_totalLiquidity)); //util rate after. 1000000 = 100.000%
        
        //calc 0=>u1 area
        int128 ln_u1 = calculator.ln(calculator.fromUInt(u1.add(a)));
        uint256 ln_res_u1 = calculator.mulu(ln_u1, k).mul(365);
        uint256 _premium_u1 = ln_res_u1.add(_b.mul(u1)).sub(a.mul(365).mul(u1));

        //calc 0=>u2 area
        int128 ln_u2 = calculator.ln(calculator.fromUInt(u2.add(a)));
        uint256 ln_res_u2 = calculator.mulu(ln_u2, k).mul(365); //365kln(x+a): 10 degits accuracy
        uint256 _premium_u2 = ln_res_u2.add(_b.mul(u2)).sub(a.mul(365).mul(u2)); //365kln(x+a)+(b-365a)x: 10 degits accuracy

        //(u1 area) - (u2 area) = premium rate between u1 and u2
        uint256 premiumRate = _premium_u1.sub(_premium_u2);
        
        return premiumRate;
    }
    
    /***
    * @notice Get premium. This returns token amount of premium buyer has to pay.
    * @param _amount 
    * @param _term
    * @param _totalLiquidity total liquidity token amount in the insurance pool.
    * @param _lockedAmount utilized token amount of the insurance pool.
    */
    function getPremium(
        uint256 _amount,
        uint256 _term,
        uint256 _totalLiquidity,
        uint256 _lockedAmount
    ) external view returns (uint256) {
        require(_amount.add(_lockedAmount) <= _totalLiquidity, "Amount exceeds.");
        require(_totalLiquidity != 0, "_totalLiquidity cannnot be 0");

        if (_amount == 0) {
            return 0;
        }
        
        uint256 premiumRate = getPremiumRate(_amount, _totalLiquidity, _lockedAmount);

        uint256 premium = _amount.mul(premiumRate).mul(_term).div(365 days).div(BASE_DIGITS_x2);
        
        return premium;
    }

    /**
     * @notice Set a premium model
     * @param _baseRatePerYear The Base rate addition to the bonding curve. (scaled by 1e5)
     * @param _multiplierPerYear The rate of mixmum premium(scaled by 1e5)
     */
    function setPremium(uint256 _baseRatePerYear, uint256 _multiplierPerYear)
        external
        onlyOwner
    {
        b = _baseRatePerYear;
        k = _multiplierPerYear;
        a = sqrt(BASE_DIGITS.mul(BASE_DIGITS).add(k.mul(4))).sub(BASE_DIGITS).div(2);
    }

    /***
     * @notice Set optional parameters
     * @param _a low_risk_border
     * @param _b low_risk_b
     * @param _c low_risk_util
     * @param _d unused slot
     */
    function setOptions(
        uint256 _a,
        uint256 _b,
        uint256 _c,
        uint256 _d
    ) external onlyOwner {
        require(_b < b, "low_risk_base_fee must lower than base_fee");

        low_risk_liquidity = _a;
        low_risk_b = _b;
        low_risk_util = _c;
    }

    function sqrt(uint256 x) internal pure returns (uint256 y) {
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }

    function commitTransferOwnership(address addr)external {
        /***
        *@notice Transfer ownership of GaugeController to `addr`
        *@param addr Address to have ownership transferred to
        */
        require (msg.sender == owner, "dev: admin only");
        future_owner = addr;
        emit CommitOwnership(addr);
    }

    function acceptTransferOwnership()external {
        /***
        *@notice Accept a transfer of ownership
        *@return bool success
        */
        require(future_owner != address(0), "dev: no active transfer");
        require(address(msg.sender) == future_owner, "dev: future_admin only");

        owner = future_owner;

        emit AcceptOwnership(owner);
    }
}