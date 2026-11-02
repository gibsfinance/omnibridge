// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ArmedCall} from "./MockArmedCaller.sol";

/**
 * @title MockArmedCallToken
 * @dev A hostile token: on its next transfer after {ArmedCall.arm}, it makes the
 * armed call from inside that transfer, after the balances move. Used to test
 * what a token in the mediator's escrow can do while the mediator releases it.
 */
contract MockArmedCallToken is ERC20, ArmedCall {
    constructor() ERC20("Armed Token", "ARM") {}

    /// @dev Mints `value` tokens to `to`. Test only.
    function mint(address to, uint256 value) external {
        _mint(to, value);
    }

    /// @dev Moves the tokens, then makes the armed call if one is armed.
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        _fireArmedCall();
    }
}
