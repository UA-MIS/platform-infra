import { makeStyles } from '@material-ui/core';
import { misLogoDataUri } from './misLogo';

// The full "MiS" wordmark shown when the sidebar is expanded. The source PNG is black on
// transparency and the sidebar rail is charcoal in both UA-MIS themes, so we invert it to
// white for contrast. Height matches the stock Backstage LogoFull (30px).
const useStyles = makeStyles({
  img: {
    height: 30,
    width: 'auto',
    display: 'block',
    // black artwork -> white on the charcoal sidebar
    filter: 'brightness(0) invert(1)',
  },
});

export const LogoFull = () => {
  const classes = useStyles();

  return (
    <img
      className={classes.img}
      src={misLogoDataUri}
      alt="University of Alabama MIS — The Process"
    />
  );
};
