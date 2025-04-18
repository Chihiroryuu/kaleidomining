// miner.js
import axios from 'axios'
import chalk from 'chalk'
import * as fs from 'fs/promises';
import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {displayBanner} from './banner.js';

class KaleidoMiningBot {
    constructor(wallet, botIndex) {
        this.wallet = wallet;
        this.botIndex = botIndex;
        this.currentEarnings = { total: 0, pending: 0, paid: 0 };
        this.miningState = {
            isActive: false,
            worker: "quantum-rig-1",
            pool: "quantum-1",
            startTime: null
        };
        this.referralBonus = 0;
        this.stats = {
            hashrate: 75.5,
            shares: { accepted: 0, rejected: 0 },
            efficiency: 1.4,
            powerUsage: 120
        };
        this.sessionFile = `session_${wallet}.json`;

        this.api = axios.create({
            baseURL: 'https://kaleidofinance.xyz/api/testnet',
            headers: {
                'Content-Type': 'application/json',
                'Referer': 'https://kaleidofinance.xyz/testnet',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
            }
        });
    }

    validateEarnings(earnings) {
        return (
            typeof earnings === 'number' &&
            !isNaN(earnings) &&
            isFinite(earnings) &&
            earnings >= 0
        );
    }

    async loadSession() {
        try {
            const data = await fs.readFile(this.sessionFile, 'utf8');
            const session = JSON.parse(data);
            this.miningState.startTime = session.startTime;
            this.currentEarnings = session.earnings;
            this.referralBonus = session.referralBonus;
            console.log(chalk.green(`[Wallet ${this.botIndex}] Previous session loaded successfully`));
            return true;
        } catch (error) {
            return false;
        }
    }

    async saveSession() {
        const sessionData = {
            startTime: this.miningState.startTime,
            earnings: this.currentEarnings,
            referralBonus: this.referralBonus
        };

        try {
            await fs.writeFile(this.sessionFile, JSON.stringify(sessionData, null, 2));
        } catch (error) {
            console.error(chalk.red(`[Wallet ${this.botIndex}] Failed to save session:`), error.message);
        }
    }

    async initialize() {
        try {
            const regResponse = await this.retryRequest(
                () => this.api.get(`/check-registration?wallet=${this.wallet}`),
                "Registration check"
            );

            if (!regResponse.data.isRegistered) {
                throw new Error('Wallet not registered');
            }

            const hasSession = await this.loadSession();

            if (!hasSession) {
                this.referralBonus = regResponse.data.userData.referralBonus || 0;
                this.currentEarnings = {
                    total: this.referralBonus,
                    pending: 0,
                    paid: 0
                };
                this.miningState.startTime = Date.now();
            } else if (!this.miningState.startTime) {
                this.miningState.startTime = Date.now();
            }

            this.miningState.isActive = true;

            console.log(chalk.green(`[Wallet ${this.botIndex}] Mining ${hasSession ? 'resumed' : 'initialized'} successfully`));
            await this.startMiningLoop();

        } catch (error) {
            if (error.response) {
                console.error(chalk.red(`[Wallet ${this.botIndex}] Init Error ${error.response.status}: ${JSON.stringify(error.response.data)}`));
            } else {
                console.error(chalk.red(`[Wallet ${this.botIndex}] Initialization failed:`), error.message);
            }
        }
    }

    async retryRequest(requestFn, operationName, retries = 3) {
        for (let i = 0; i < retries; i++) {
            try {
                return await requestFn();
            } catch (error) {
                if (i === retries - 1) throw error;
                console.log(chalk.yellow(`[${operationName}] Retrying (${i + 1}/${retries})...`));
                await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
            }
        }
    }

    calculateEarnings() {
        if (!this.miningState.startTime) {
            console.warn(chalk.red(`[Wallet ${this.botIndex}] Missing startTime, returning 0 earnings`));
            return 0;
        }
        const timeElapsed = (Date.now() - this.miningState.startTime) / 1000;
        return (this.stats.hashrate * timeElapsed * 0.0001) * (1 + this.referralBonus);
    }

    async updateBalance(finalUpdate = false) {
        try {
            const newEarnings = this.calculateEarnings();

            if (!this.validateEarnings(newEarnings)) {
                console.error(chalk.red(`[Wallet ${this.botIndex}] Invalid earnings value.`));
                return;
            }

            const payload = {
                wallet: this.wallet,
                earnings: {
                    total: this.currentEarnings.total + newEarnings,
                    pending: finalUpdate ? 0 : newEarnings,
                    paid: finalUpdate ? this.currentEarnings.paid + newEarnings : this.currentEarnings.paid
                }
            };

            const response = await this.retryRequest(
                () => this.api.post('/update-balance', payload),
                "Balance update"
            );

            if (response.data.success) {
                this.currentEarnings = {
                    total: response.data.balance,
                    pending: finalUpdate ? 0 : newEarnings,
                    paid: finalUpdate ? this.currentEarnings.paid + newEarnings : this.currentEarnings.paid
                };

                await this.saveSession();
                this.logStatus(finalUpdate);
            } else {
                console.error(chalk.red(`[Wallet ${this.botIndex}] Server responded but update failed:`), response.data);
            }
        } catch (error) {
            if (error.response) {
                console.error(chalk.red(`[Wallet ${this.botIndex}] API Error ${error.response.status}: ${JSON.stringify(error.response.data)}`));
            } else {
                console.error(chalk.red(`[Wallet ${this.botIndex}] Update failed:`), error.message);
            }
        }
    }

    logStatus(final = false) {
        const statusType = final ? "Final Status" : "Mining Status";
        const uptime = ((Date.now() - this.miningState.startTime) / 1000).toFixed(0);

        console.log(chalk.yellow(`
        === [Wallet ${this.botIndex}] ${statusType} ===
        Wallet: ${this.wallet}
        Uptime: ${uptime}s | Active: ${this.miningState.isActive}
        Hashrate: ${this.stats.hashrate} MH/s
        Total: ${chalk.cyan(this.currentEarnings.total.toFixed(8))} KLDO
        Pending: ${chalk.yellow(this.currentEarnings.pending.toFixed(8))} KLDO
        Paid: ${chalk.green(this.currentEarnings.paid.toFixed(8))} KLDO
        Referral Bonus: ${chalk.magenta(`+${(this.referralBonus * 100).toFixed(1)}%`)}
        `));
    }

    async startMiningLoop() {
        while (this.miningState.isActive) {
            await this.updateBalance();
            await new Promise(resolve => setTimeout(resolve, 30000));
        }
    }

    async stop() {
        this.miningState.isActive = false;
        await this.updateBalance(true);
        await this.saveSession();
        return this.currentEarnings.paid;
    }
}

export class MiningCoordinator {
    static instance = null;

    constructor() {
        if (MiningCoordinator.instance) {
            return MiningCoordinator.instance;
        }
        MiningCoordinator.instance = this;

        this.bots = [];
        this.totalPaid = 0;
        this.isRunning = false;
    }

    async loadWallets() {
        try {
            const __dirname = dirname(fileURLToPath(import.meta.url));
            const data = await readFile(join(__dirname, 'wallets.txt'), 'utf8');
            return data.split('\n')
                .map(line => line.trim())
                .filter(line => /^0x[a-fA-F0-9]{40}$/.test(line));
        } catch (error) {
            console.error('Error loading wallets:', error.message);
            return [];
        }
    }

    async start() {
        if (this.isRunning) {
            console.log(chalk.yellow('Mining coordinator is already running'));
            return;
        }

        this.isRunning = true;
        displayBanner();
        const wallets = await this.loadWallets();

        if (wallets.length === 0) {
            console.log(chalk.red('No valid wallets found in wallets.txt'));
            return;
        }

        console.log(chalk.blue(`Loaded ${wallets.length} wallets\n`));

        this.bots = wallets.map((wallet, index) => {
            const bot = new KaleidoMiningBot(wallet, index + 1);
            bot.initialize();
            return bot;
        });

        process.on('SIGINT', async () => {
            console.log(chalk.yellow('\nShutting down miners...'));
            this.totalPaid = (await Promise.all(this.bots.map(bot => bot.stop())))
                .reduce((sum, paid) => sum + paid, 0);

            console.log(chalk.green(`
            === Final Summary ===
            Total Wallets: ${this.bots.length}
            Total Paid: ${this.totalPaid.toFixed(8)} KLDO
            `));
            process.exit();
        });
    }
}
