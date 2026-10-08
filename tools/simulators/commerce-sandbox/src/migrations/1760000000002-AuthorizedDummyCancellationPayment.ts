type MigrationQueryRunner = { query(sql: string): Promise<unknown> };
export class AuthorizedDummyCancellationPayment1760000000002 {
    name = 'AuthorizedDummyCancellationPayment1760000000002';
    async up(queryRunner: MigrationQueryRunner): Promise<void> {
        await queryRunner.query('ALTER TABLE cso_zero_total_cancellation_marker ADD COLUMN payment_id TEXT');
    }
    async down(queryRunner: MigrationQueryRunner): Promise<void> {
        await queryRunner.query('ALTER TABLE cso_zero_total_cancellation_marker DROP COLUMN payment_id');
    }
}
