import { Router, type IRouter } from "express";
import healthRouter from "./health";
import geoRouter from "./geo";

const router: IRouter = Router();

router.use(healthRouter);
router.use(geoRouter);

export default router;
