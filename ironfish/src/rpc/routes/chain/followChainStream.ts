/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { isValidRandomness } from '@ironfish/rust-nodejs'
import * as yup from 'yup'
import { Assert } from '../../../assert'
import { ChainProcessor } from '../../../chainProcessor'
import { getBlockSize, getTransactionSize } from '../../../network/utils/serializers'
import { Block, BlockHeader } from '../../../primitives'
import { BlockHashSerdeInstance } from '../../../serde'
import { BufferUtils, PromiseUtils } from '../../../utils'
import { ApiNamespace, routes } from '../router'
import { RpcTransaction, RpcTransactionSchema } from './types'

export type FollowChainStreamRequest =
  | {
      head?: string | null
      serialized?: boolean
    }
  | undefined

export type FollowChainStreamResponse = {
  type: 'connected' | 'disconnected' | 'fork'
  head: {
    sequence: number
  }
  block: {
    hash: string
    sequence: number
    previous: string
    graffiti: string
    difficulty: string
    size: number
    timestamp: number
    work: string
    main: boolean
    noteSize: number | null
    transactions: RpcTransaction[]
  }
}

export const FollowChainStreamRequestSchema: yup.ObjectSchema<FollowChainStreamRequest> = yup
  .object({
    head: yup.string().nullable().optional(),
    serialized: yup.boolean().optional(),
  })
  .optional()

export const FollowChainStreamResponseSchema: yup.ObjectSchema<FollowChainStreamResponse> = yup
  .object({
    type: yup.string().oneOf(['connected', 'disconnected', 'fork']).defined(),
    head: yup
      .object({
        sequence: yup.number().defined(),
      })
      .defined(),
    block: yup
      .object({
        hash: yup.string().defined(),
        sequence: yup.number().defined(),
        previous: yup.string().defined(),
        timestamp: yup.number().defined(),
        graffiti: yup.string().defined(),
        size: yup.number().defined(),
        work: yup.string().defined(),
        main: yup.boolean().defined(),
        difficulty: yup.string().defined(),
        noteSize: yup.number().nullable().defined(),
        transactions: yup.array(RpcTransactionSchema).defined(),
      })
      .defined(),
  })
  .defined()

routes.register<typeof FollowChainStreamRequestSchema, FollowChainStreamResponse>(
  `${ApiNamespace.chain}/followChainStream`,
  FollowChainStreamRequestSchema,
  async (request, { node }): Promise<void> => {
    Assert.isNotUndefined(node)
    const head = request.data?.head ? Buffer.from(request.data.head, 'hex') : null

    const processor = new ChainProcessor({
      chain: node.chain,
      logger: node.logger,
      head: head,
    })
    let successFr = 0
    let failFr = 0

    const send = (block: Block, type: 'connected' | 'disconnected' | 'fork') => {
      console.log(`seq: ${block.header.sequence} success: ${successFr}, fail ${failFr}`)
      const transactions = block.transactions.map((transaction) => {
        return transaction.withReference(() => {
          return {
            ...(request.data?.serialized
              ? { serialized: transaction.serialize().toString('hex') }
              : {}),
            hash: BlockHashSerdeInstance.serialize(transaction.hash()),
            size: getTransactionSize(transaction),
            fee: Number(transaction.fee()),
            expiration: transaction.expiration(),
            notes: transaction.notes.map((note) => {
              // get 32 bytes after first 64 bytes for test, need also to decrypt with chacha20, see rust/src/serializing/aead
              // will likely need a second rust method for partial decryption
              if (isValidRandomness(note.serialize().toString('hex'))) {
                successFr += 1
              } else {
                failFr += 1
              }
              return {
                commitment: note.hash().toString('hex'),
              }
            }),
            spends: transaction.spends.map((spend) => ({
              nullifier: spend.nullifier.toString('hex'),
              commitment: spend.commitment.toString('hex'),
              size: spend.size,
            })),
            mints: transaction.mints.map((mint) => ({
              id: mint.asset.id().toString('hex'),
              metadata: BufferUtils.toHuman(mint.asset.metadata()),
              name: BufferUtils.toHuman(mint.asset.name()),
              owner: mint.asset.owner().toString('hex'),
              value: mint.value.toString(),
            })),
            burns: transaction.burns.map((burn) => ({
              id: burn.assetId.toString('hex'),
              value: burn.value.toString(),
            })),
          }
        })
      })

      request.stream({
        type: type,
        head: {
          sequence: node.chain.head.sequence,
        },
        block: {
          hash: block.header.hash.toString('hex'),
          sequence: block.header.sequence,
          previous: block.header.previousBlockHash.toString('hex'),
          graffiti: BufferUtils.toHuman(block.header.graffiti),
          size: getBlockSize(block),
          work: block.header.work.toString(),
          main: type === 'connected',
          timestamp: block.header.timestamp.valueOf(),
          difficulty: block.header.target.toDifficulty().toString(),
          noteSize: block.header.noteSize,
          transactions,
        },
      })
    }

    const onAdd = async (header: BlockHeader) => {
      const block = await node.chain.getBlock(header)
      Assert.isNotNull(block)
      send(block, 'connected')
    }

    const onRemove = async (header: BlockHeader) => {
      const block = await node.chain.getBlock(header)
      Assert.isNotNull(block)
      send(block, 'disconnected')
    }

    const onFork = (block: Block) => {
      send(block, 'fork')
    }

    processor.onAdd.on(onAdd)
    processor.onRemove.on(onRemove)
    node.chain.onForkBlock.on(onFork)
    const abortController = new AbortController()

    request.onClose.on(() => {
      abortController.abort()
      processor.onAdd.off(onAdd)
      processor.onRemove.off(onRemove)
      node.chain.onForkBlock.off(onFork)
    })

    while (!request.closed) {
      await processor.update({ signal: abortController.signal })
      await PromiseUtils.sleep(1000)
    }

    request.end()
  },
)
