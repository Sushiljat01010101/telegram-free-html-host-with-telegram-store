import { Router, type IRouter } from "express";
import healthRouter from "./health";
import viewRouter from "./view";

const router: IRouter = Router();

router.use(healthRouter);
router.use(viewRouter);

export default router;
