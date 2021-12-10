describe('CDSTemplate', function(){
    describe('initialize', function() {
        it('should initialize once time', async () => {
            // 91
            // "ERROR: INITIALIZATION_BAD_CONDITIONS"
        });    
    });

    describe('deposit', function() {
        it('should not amount is zero', async ()=>{
            // 125
            // "ERROR: DEPOSIT_ZERO"
        });
        it('total liquidity is zero, supply is more than zero', async () => {
            // 139
        });
    });

    describe("requestWithdraw", function() {
        it("balance should be more than amount", async () => {
            // 156
            // "ERROR: REQUEST_EXCEED_BALANCE"
        });
        it("amount should not be zero", async () => {
            // 157
            // "ERROR: REQUEST_ZERO"
        });
    });

    describe("withdraw", function(){
        it("paused should be 'true'", async () => {
            // 171
            // "ERROR: WITHDRAWAL_PENDING"
        });
        it("time", async () => {
            // 176
            // "ERROR: WITHDRAWAL_NO_ACTIVE_REQUEST"
        });
    });

    describe("compensate", function () {
        it("msg.sender should be listed", async () => {
            // 208
            // no error code...
        });
    });

    describe("rate", function() {
        it("totalsupply should not zero", async () => {
            // 248
        });
    });

    describe("valueOfUnderlying", function() {
        it("", async () => {
            // 259

        });
        it("", async () => {
            // 262
        });
    });

    describe("setPaused", function () {
        it("", async () => {
            // 285
        });
    });

    describe("_beforeTokenTransfer", function(){
        it("", async () => {
            // 311
        });
    });
});

describe('Factory', function(){
    describe("approveTemplate", function () {
        it("should not zero address", async () => {
            // 100
            // 
        });
    });
    describe("setCondition", function(){
        it("false", async () => {
            //138
        });
        it("success", async () => {
            //139
        });
    });
    describe("createMarket", function() {
        it("fail when templates are authorized", async () => {
            // 158
            // UNAUTHORIZED_TEMPLATE
        });
        it("fail when sender is not authorized", async () => {
            // 162
            // UNAUTHORIZED_SENDER
        });
        it("fail when sender is not authorized", async () => {
            // 162
            // UNAUTHORIZED_SENDER
        });
        // reference
        it("length of reference is zero", async () => {
            // 165
            // _reference.length == 0
        });
        it("fail when an address is not authorized within the template", async () => {
            // 167
            // UNAUTHORIZED_REFERENCE
        });
        it("Fail when zero address", async () => {
            // 167
            // UNAUTHORIZED_REFERENCE
        });
        it("length of condition is zero", async () => {
            // 175
            // _conditions.length == 0
        });
        it("condition is zero", async () => {
            // 177
            // conditionlist[address(_template)][i] == 0
        });
        it("", async () => {});
    });
});

describe('FeeModel', function(){
    describe("setFee", function(){
        it("Fail when target is more than Max_rate", async () => {
            // 45
            // ERROR: MAX_RATE_EXCEEDED
        });
    });
});

describe("InsureDAOERC20", function() {
    describe("basic infomation", function() {
        it("name", async () => {

        });
        it("symbol", async () => {

        });
        it("decimals", async () => {

        });
    });
    describe("transferFrom", function(){
        it("", async () => {
            // _transfer
        });
        it("", async () => {

        });
        it("Fail when current allowance is less than amount", async () => {

        });
});

describe("Parameters", function () {
    describe("setPremiumModel, setFeeModel", function () {
        it("_target should not be zero address", async () => {
            // 161
            // dev: zero address
        });
        it("_target should not be zero address", async () => {
            // 172
            // dev: zero address
        });
    });
    describe("setCondition", function () {
        it("success", async () => {
            // 192
        });
        it("fail", async () => {
            // ??
        });
    });
    describe("return non default values", function () {
        it("getPremium", async () => {
            // 250
        });
        it("getFee", async () => {
            // 274
        });
        it("getDeposit", async () =>{
            //
        });
        it("getDepositFee", async () =>{

        });
        it("getCDSPremium", async () =>{
            // 
        });
        it("getMaxList", async () => {
            // 375
        });
    });
    describe("getCondition", function () {
        it("getCondition", async () => {
            // 384
        });
    })
});


describe("PoolTemplate", function () {
    describe("initialize", function () {
        it("", async () => {

        });
        it("", async () => {

        });
        it("", async () => {

        });
        it("", async () => {

        });
        it("", async () => {

        });
        it("", async () => {

        });
    });
    describe("deposit", function () {
        it("fail when amount is not more than zero", async () => {
            // 246
            // ERROR: DEPOSIT_ZERO
        });
    });
    describe("requestWithdraw", function () {
        it("fail when amount is not more than zero", async () => {
            //270
        });
    });
    describe("withdraw", function () {
        it("earlier than timestamp", async () => {
            // 291
            // ERROR: WITHDRAWAL_QUEUE
        });
    });
    describe("unlockBatch", function () {
        it("Unlocks an array of insurances", async () => {

        });
    });
    describe("allocateCredit", function () {
        it("bat condition", async () => {
            //400
            //ERROR: WITHDRAW_CREDIT_BAD_CONDITIONS
        })
        it("", async () => {

        });
        it("", async () => {
            
        });
    });
    describe("insure", function () {
        it("exeeded amount", async () => {
            // 452
            // ERROR: INSURE_EXCEEDED_AVAILABLE_BALANCE
        });
        it("", async () => {
            // 455
            // ERROR: INSURE_EXCEEDED_MAX_COST
        });
        it("", async () => {
            // 456
            // ERROR: INSURE_EXCEEDED_MAX_SPAN
        });
        it("", async () => {
            // 457
            // ERROR: INSURE_SPAN_BELOW_MIN
        });
        it("", async () => {
            // 462
            // ERROR: INSURE_MARKET_PENDING"
        });
        it("", async () => {
            // 4
            // 
        });
    });
    describe("redeem", function () {
        it("", async () => {});

    });
    describe("transferInsurance", function () {
        it("", async () => {});
    });
    describe("", function () {
        it("", async () => {
            // 
            // 
        });
    });
});
});


describe("registry", function () {
    describe("setFactory", function () {
        it("should not zero address", async () => {
            // 45
            // dev: zero address
        });
    });

    describe("supportMarket", function () {
        it("should not exist", async () => {
            // 56
            // 
        });
        it("msgSender should be factory address", async () => {
            // 57
        });
        it("msgSender should be owner address", async () => {
            // 57
        });
        it("market address should not be zero address", async () => {
            // 58
            // dev: zero address
        });
    });

    describe("setExistence", function () {
        it("msgSender should be factory address", async () => {
            // 71
        });
        it("msgSender should be owner address", async () => {
            // 71
        });
    });

    describe("setCDS", function () {
        it("cds address should not be zero address", async () => {
            // 84
            // dev: zero address
        });
    });

});
