// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

/**
 * @title MockCourierFilter
 * @dev An outside courier filter with its own list, which a test can make
 * revert on every query. Used to test a router pointed at another filter.
 */
contract MockCourierFilter {
    /// @dev Every query reverts while {reverting} is true.
    error FilterUnavailable();

    /// @notice The couriers this filter lists.
    mapping(address => bool) public listed;
    /// @notice True when every {isCourier} query reverts.
    bool public reverting;

    /**
     * @dev Adds `courier` to, or removes it from, this filter's list.
     * @param courier the address to list or unlist
     * @param isListed whether the address is listed
     */
    function setCourier(address courier, bool isListed) external {
        listed[courier] = isListed;
    }

    /**
     * @dev Makes every {isCourier} query revert, or stop reverting.
     * @param value whether queries revert
     */
    function setReverting(bool value) external {
        reverting = value;
    }

    /**
     * @dev Whether `courier` is listed. Reverts {FilterUnavailable} while {reverting} is true.
     * @param courier the address to check
     */
    function isCourier(address courier) external view returns (bool) {
        if (reverting) revert FilterUnavailable();
        return listed[courier];
    }
}
