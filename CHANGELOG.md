# Changelog

All notable changes to this integration are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/), bumped by the Release workflow.

## [Unreleased]

## [2.2.0] - 2026-10-07

- Maintenance release, no functional change.

## [2.1.0] - 2026-10-06

### Added

- `SECURITY.md`: how to report a vulnerability.
- `CHANGELOG.md`, rebuilt from the release history.

### Changed

- Development dependencies updated to their latest versions (ESLint 10.12, Prettier 3.9.9, globals 17.13).

### Fixed

- A search failing right after a container start (network not up yet, open data API down) no longer stops every price refresh until a reconnection or a configuration change: the refresh loop is armed before the first search, and a failed discovery only costs the Discovery tab until the next scan.

## [2.0.11] - 2026-10-04

### Changed

- Name the real search centre in the preview, and stop calling it "around me"

## [2.0.10] - 2026-10-03

### Changed

- Name the house in use, and keep "My station" to the configured fuels

## [2.0.9] - 2026-09-28

### Changed

- Keep the picked fuel on the "My station" card when it has no price today

## [2.0.8] - 2026-09-24

### Changed

- Let the user choose how long station names are on the ranking card
- Tell apart two stations of one street, or of one address, in the ranking

## [2.0.7] - 2026-09-23

### Changed

- Show a silent fuel the station sold recently as out of stock, not "not sold"

## [2.0.6] - 2026-09-22

### Changed

- Answer inside the ack deadline, keep three decimals, name the house

## [2.0.5] - 2026-09-22

### Changed

- A ranking row keeps its city behind the street it reveals

## [2.0.4] - 2026-09-22

### Changed

- A ranking row shows its street when its city is shared

## [2.0.3] - 2026-09-22

### Changed

- Make the ranking rows name the station they rank
- Keep the brand on a ranking row that reveals its street

## [2.0.2] - 2026-09-22

### Changed

- Keep the declared date whole in the ranking rows

## [2.0.1] - 2026-09-22

### Changed

- Shorten the declared date in the ranking rows

## [2.0.0] - 2026-09-21

### Added

- Propose two dashboard widgets
- Redesign the ranking card, and say where distances start
- Measure from the Gladys house, and draw the curve from day one
- Declare the scene triggers of Gladys#3110 (preview)
- Declare the scene actions of Gladys#3110 (preview)
- Target Gladys 5.1, which ships the widgets and the scenes

### Fixed

- Answer the widget commands the SDK ignores
- No future dates on the curve, and the two dates back
- Return the station on the out-of-stock path too

## [1.0.7] - 2026-09-21

### Added

- Distinguish a fuel out of stock from a fuel not sold

## [1.0.6] - 2026-09-21

### Added

- Distinguish two stations of the same brand in one city

## [1.0.5] - 2026-09-20

### Added

- Declare the cloud transport and explain the missing SP95

## [1.0.4] - 2026-08-15

### Added

- Target Gladys 4.86 and declare the store catalog categories
- Keep only the "energy" catalog category

## [1.0.3] - 2026-08-10

### Fixed

- Find the stations a postal code search was silently dropping

## [1.0.2] - 2026-08-08

### Added

- Show the price update date in a readable form
- Add a global 'last data refresh' device, and one date format

### Changed

- Add CLAUDE.md with commands and architecture notes

### Fixed

- Name the integration device in French

## [1.0.1] - 2026-08-06

First public release.

### Added

- Fuel prices integration for Gladys Assistant

### Fixed

- Empty Discovery tab, caused by an invalid poll_frequency
- Show the station brand in Discovery and in the preview
- Fetch the station name, and unblock "Add to Gladys" (HTTP 422)

[Unreleased]: https://github.com/prohand/gladys-prixcarburants/compare/v2.2.0...HEAD
[2.2.0]: https://github.com/prohand/gladys-prixcarburants/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/prohand/gladys-prixcarburants/compare/v2.0.11...v2.1.0
[2.0.11]: https://github.com/prohand/gladys-prixcarburants/compare/v2.0.10...v2.0.11
[2.0.10]: https://github.com/prohand/gladys-prixcarburants/compare/v2.0.9...v2.0.10
[2.0.9]: https://github.com/prohand/gladys-prixcarburants/compare/v2.0.8...v2.0.9
[2.0.8]: https://github.com/prohand/gladys-prixcarburants/compare/v2.0.7...v2.0.8
[2.0.7]: https://github.com/prohand/gladys-prixcarburants/compare/v2.0.6...v2.0.7
[2.0.6]: https://github.com/prohand/gladys-prixcarburants/compare/v2.0.5...v2.0.6
[2.0.5]: https://github.com/prohand/gladys-prixcarburants/compare/v2.0.4...v2.0.5
[2.0.4]: https://github.com/prohand/gladys-prixcarburants/compare/v2.0.3...v2.0.4
[2.0.3]: https://github.com/prohand/gladys-prixcarburants/compare/v2.0.2...v2.0.3
[2.0.2]: https://github.com/prohand/gladys-prixcarburants/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/prohand/gladys-prixcarburants/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/prohand/gladys-prixcarburants/compare/v1.0.7...v2.0.0
[1.0.7]: https://github.com/prohand/gladys-prixcarburants/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/prohand/gladys-prixcarburants/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/prohand/gladys-prixcarburants/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/prohand/gladys-prixcarburants/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/prohand/gladys-prixcarburants/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/prohand/gladys-prixcarburants/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/prohand/gladys-prixcarburants/releases/tag/v1.0.1
