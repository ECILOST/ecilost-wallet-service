import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { WalletService } from '../../application/wallet.service';
import { WalletController } from './wallet.controller';

const student = { id: 'student-id', role: 'STUDENT' };
const wallet = { userId: student.id, availableBalance: 1000 };

function setup() {
  const service = {
    findByUser: vi.fn(),
    bootstrap: vi.fn(),
    listTransactions: vi.fn(),
    recharge: vi.fn(),
  };
  const controller = new WalletController(service as unknown as WalletService);
  return { service, controller };
}

describe('WalletController', () => {
  it('reads the wallet of the current user without creating a missing wallet', async () => {
    const { service, controller } = setup();
    service.findByUser.mockResolvedValueOnce(wallet).mockResolvedValueOnce(null);

    await expect(controller.mine(student)).resolves.toEqual(wallet);
    await expect(controller.mine(student)).rejects.toBeInstanceOf(NotFoundException);
    expect(service.findByUser).toHaveBeenCalledWith(student.id);
    expect(service.bootstrap).not.toHaveBeenCalled();
  });

  it('bootstraps the current user only when explicitly requested', async () => {
    const { service, controller } = setup();
    service.bootstrap.mockResolvedValue(wallet);

    await expect(controller.bootstrap(student)).resolves.toEqual(wallet);
    expect(service.bootstrap).toHaveBeenCalledWith(student.id);
  });

  it('paginates transactions for the current user', async () => {
    const { service, controller } = setup();
    const result = { items: [], total: 0 };
    service.listTransactions.mockResolvedValue(result);

    await expect(controller.listTransactions(student, { page: 2, pageSize: 10 })).resolves.toEqual(result);
    expect(service.listTransactions).toHaveBeenCalledWith(student.id, 2, 10);
  });

  it('preserves the operator id and reference on a recharge', async () => {
    const { service, controller } = setup();
    const actor = { id: 'operator-id', role: 'STAFF' };
    service.recharge.mockResolvedValue(wallet);

    await expect(controller.recharge(student.id, { amount: 25, reference: 'receipt-1' }, actor))
      .resolves.toEqual(wallet);
    expect(service.recharge).toHaveBeenCalledWith(student.id, 25, actor.id, 'receipt-1');
  });
});
