// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {IWETH as IWNative} from "../interfaces/IWETH.sol";
import {TokenOmnibridgeRouter} from "../helpers/TokenOmnibridgeRouter.sol";

/**
 * @title RouterRecoveryBodyHarness
 * @dev The production router plus one test-only door into the recovery body.
 * Both public paths ({recover} and the single entry) check `processed` before
 * they reach the body, so the body's own `processed` check cannot be reached
 * from outside. This door skips the outer check, so a test can prove that the
 * body alone still refuses to pay a message twice.
 */
contract RouterRecoveryBodyHarness is TokenOmnibridgeRouter {
    constructor(address _bridge, IWNative _wNative, address _owner) TokenOmnibridgeRouter(_bridge, _wNative, _owner) {}

    /**
     * @dev Runs the guarded recovery body without the cheap `processed` check
     * that {recover} makes first.
     * @param message the Arbitrary Message Bridge message, exactly as signed
     * @param signatures the validator signatures over that message
     * @return outcome what the recovery body returned
     */
    function recoverWithoutOuterProcessedCheck(bytes calldata message, bytes calldata signatures)
        external
        returns (DeliveryOutcome outcome)
    {
        return _recoverWithReentrancyGuard(message, signatures);
    }
}
