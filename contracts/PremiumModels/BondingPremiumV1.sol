pragma solidity 0.8.7;

/***
* @title BondingPremiumV1
* @author InsureDAO
* SPDX-License-Identifier: MIT
* @notice Calculate premium to purchase insurance.
*/

/**
* Premium Model Explanation: https://insuredao.gitbook.io/insuredao/advanced/premium-pricing
* Interactive Graph: https://www.desmos.com/calculator/zrusmh2gto
*/

/***
* @dev only applicable for USDC (6 decimals)
*/

import "@openzeppelin/contracts/utils/math/SafeMath.sol";

contract BondingPremiumV1 {
    using SafeMath for uint256;

    event CommitOwnership(address future_owner);
    event AcceptOwnership(address owner);

    uint256 public k; //k in the formula. Constant
    uint256 public b; //b in the formula. Yearly Base fee percentage. (1000000 = 100%)
    uint256 public a; //a in the formula. depending on k

    uint256 public low_risk_util; //util rate requirement to apply low_risk_b
    uint256 public low_risk_liquidity; //total liquidity amount requirement to apply low_risk_b
    uint256 public low_risk_b; //lower base fee for huge insurance pool.

    address public owner;
    address public future_owner;

    uint256 BASE_DIGITS = uint256(1e6); //bonding curve graph takes 1e6 as 100.0000%
    uint256 DIGITS_ADJUSTER = uint256(10);

    modifier onlyOwner() {
        require(msg.sender == owner, "Restricted: caller is not allowed to operate");
        _;
    }

    /***
    * @notice Set a initial parameters. You can see this model's graph here https://www.desmos.com/calculator/zrusmh2gto
    */
    constructor() {
        b = 30000; //3%
        k = 300100000;
        a = (
            BASE_DIGITS.add(sqrt(BASE_DIGITS.mul(BASE_DIGITS).add(k.mul(4))))
        ).div(2).sub(BASE_DIGITS);//quadratic formula

        low_risk_b = 5000; //0.5%
        low_risk_liquidity = uint256(1e12); //1M USDC (6 decimals)
        low_risk_util = 150000; //15% utilization

        owner = msg.sender;
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
        uint256 _util = _lockedAmount.mul(1e6).div(_totalLiquidity);

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
                .div(10); //change 100.0000% to 100.000%
        } else {
            _premiumRate = k
                .mul(365)
                .sub(Q.mul(a).mul(365))
                .add(Q.mul(b))
                .div(Q)
                .div(10); //change 100.0000% to 100.000%
        }

        //Return premium
        return _premiumRate;
    }

    /**
    * @notice Get premium. This returns token amount of premium buyer has to pay.
    * @param _totalLiquidity total liquidity token amount in the insurance pool.
    * @param _lockedAmount utilized token amount of the insurance pool.
    */
    function getPremium(
        uint256 _amount,
        uint256 _term,
        uint256 _totalLiquidity,
        uint256 _lockedAmount
    ) external view returns (uint256) {
        if (_amount == 0) {
            return 0;
        }

        uint256 pi = getCurrentPremiumRate(_totalLiquidity, _lockedAmount);
        uint256 pf = getCurrentPremiumRate(_totalLiquidity, _lockedAmount.add(_amount));

        //calc approximate area on the graph. See https://www.desmos.com/calculator/zrusmh2gto
        uint256 premium_1 = _amount.mul(pi); //calc rectangle area
        uint256 premium_2 = _amount.mul(pf.sub(pi).div(2)); //calc triangle area
        uint256 _premium = premium_1.add(premium_2);

        //change yearly premium to the premium of arbitrary period
        _premium = _premium.mul(_term).div(365 days).div(1e5);

        return _premium;
    }


    /**
    * @notice Set a premium model. This changes the shape of the graph.
    * @param _baseRatePerYear The Base rate addition to the bonding curve. (scaled by 1e5)
    * @param _multiplierPerYear The rate of mixmum premium(scaled by 1e5)
    */
    function setPremium(uint256 _baseRatePerYear, uint256 _multiplierPerYear)
        external
        onlyOwner
    {
        b = _baseRatePerYear;
        k = _multiplierPerYear;
        a = (
            BASE_DIGITS.add(sqrt(BASE_DIGITS.mul(BASE_DIGITS).add(k.mul(4))))
        ).div(2).sub(BASE_DIGITS);
    }


    /***
    * @notice Set optional parameters. 
    * @param _a low_risk_border
    * @param _b low_risk_b
    * @param _c low_risk_util
    * @param _d won't be used in this model
    */
    function setPremium2(
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


    //square root
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
