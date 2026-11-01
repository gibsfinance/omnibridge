// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title IMockTransferHook
 * @dev The hook {MockTransferHookToken} calls on a contract that receives tokens.
 */
interface IMockTransferHook {
    function onTokenTransferReceived(address from, uint256 value) external;
}

/**
 * @title MockTransferHookToken
 * @dev A token that calls the receiving contract after every transfer, the way an
 * ERC-777 token calls tokensReceived. The hook gets all remaining gas and its
 * failure is ignored. Used to test what a recipient can do while a payout runs.
 */
contract MockTransferHookToken is ERC20 {
    constructor() ERC20("Hook Token", "HOOK") {}

    /// @dev Mints `value` tokens to `to`. Test only.
    function mint(address to, uint256 value) external {
        _mint(to, value);
    }

    /// @dev Moves the tokens, then calls the receiving contract's hook if it has code.
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (to.code.length == 0) {
            return;
        }
        // the result is ignored on purpose: a receiver without the hook must still receive tokens
        (bool ignored,) = to.call(abi.encodeWithSelector(IMockTransferHook.onTokenTransferReceived.selector, from, value));
        ignored;
    }
}
