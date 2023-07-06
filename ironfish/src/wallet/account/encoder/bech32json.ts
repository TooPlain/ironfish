/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { Bech32m } from '../../../utils'
import { AccountExport } from '../../walletdb/accountValue'
import { AccountDecodingOptions, AccountEncoder } from './encoder'
import { JsonEncoder } from './json'
export class Bech32JsonEncoder implements AccountEncoder {
  /**
   * @deprecated Bech32 JSON encoding is deprecated. Use the newest version of the Bech32JSONEncoder.
   */
  encode(value: AccountExport): string {
    return Bech32m.encode(new JsonEncoder().encode(value), 'ironfishaccount00000')
  }

  decode(value: string, options?: AccountDecodingOptions): AccountExport {
    const [decoded, _] = Bech32m.decode(value)
    if (!decoded) {
      throw new Error('Invalid bech32 JSON encoding')
    }
    const accountImport = new JsonEncoder().decode(decoded)
    return {
      ...accountImport,
      name: options?.name ? options.name : accountImport.name,
    }
  }
}
